import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { runWebDeploymentCli } from "./cli.ts";
import {
  createWebDeploymentDependencies as createRuntime,
  readPrivateDestinationReceipt,
} from "./runtime.ts";
import type { ApprovedRevisionDeploymentRequest } from "./approved-inputs.ts";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => {
    throw new Error("unexpected subprocess");
  }),
}));

// Exercise the actual production factory, but never inherit the test runner's
// Corepack/pnpm/Vitest selectors (or unrelated operator environment values).
// Its construction is synchronous and inert; restore the harness before any IO.
const createWebDeploymentDependencies = (
  root?: string,
  environment: NodeJS.ProcessEnv = {
    PATH: "/synthetic/bin",
    HOME: "/synthetic/home",
    CI: "1",
  }
) => {
  const harnessEnvironment = process.env;
  try {
    process.env = environment;
    return createRuntime(root);
  } finally {
    process.env = harnessEnvironment;
  }
};

const roots: string[] = [];
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "vertex-destination-test-"));
  roots.push(root);
  const directory = join(root, "private", "deployment");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "production.json");
  await writeFile(path, "{}", { mode: 0o600 });
  return { root, path, ignored: vi.fn(async () => true) };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
  vi.clearAllMocks();
  vi.restoreAllMocks();
  return vi.unstubAllEnvs();
});

describe("private destination receipt loading", () => {
  it("reads only an ignored private regular mode-0600 file", async () => {
    const fixture = await setup();
    expect(
      await readPrivateDestinationReceipt(
        fixture.path,
        fixture.root,
        fixture.ignored
      )
    ).toBe("{}");
    expect(
      await readPrivateDestinationReceipt(
        "private/deployment/production.json",
        fixture.root,
        fixture.ignored
      )
    ).toBe("{}");
    return expect(fixture.ignored).toHaveBeenCalledWith(fixture.path);
  });

  it("rejects receipt paths outside the private deployment directory", async () => {
    const fixture = await setup();
    const path = join(fixture.root, "receipt.json");
    await writeFile(path, "{}", { mode: 0o600 });
    return await expect(
      readPrivateDestinationReceipt(path, fixture.root, fixture.ignored)
    ).rejects.toThrow();
  });

  it("rejects tracked or otherwise non-ignored evidence", async () => {
    const fixture = await setup();
    fixture.ignored.mockResolvedValue(false);
    return await expect(
      readPrivateDestinationReceipt(fixture.path, fixture.root, fixture.ignored)
    ).rejects.toThrow();
  });

  it.each([0o644, 0o640, 0o400])(
    "rejects non-0600 evidence %#",
    async (mode) => {
      const fixture = await setup();
      await chmod(fixture.path, mode);
      return await expect(
        readPrivateDestinationReceipt(
          fixture.path,
          fixture.root,
          fixture.ignored
        )
      ).rejects.toThrow();
    }
  );

  it("rejects symlinked receipts and escaped parent directories", async () => {
    const fixture = await setup();
    const link = join(fixture.root, "private", "deployment", "link.json");
    await symlink(fixture.path, link);
    await expect(
      readPrivateDestinationReceipt(link, fixture.root, fixture.ignored)
    ).rejects.toThrow();
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "receipt.json"), "{}", { mode: 0o600 });
    const linkedDirectory = join(
      fixture.root,
      "private",
      "deployment",
      "linked"
    );
    await symlink(outside, linkedDirectory);
    return await expect(
      readPrivateDestinationReceipt(
        join(linkedDirectory, "receipt.json"),
        fixture.root,
        fixture.ignored
      )
    ).rejects.toThrow();
  });

  it("rejects missing, oversized, and non-file evidence", async () => {
    const fixture = await setup();
    await expect(
      readPrivateDestinationReceipt(
        join(fixture.root, "private", "deployment", "missing.json"),
        fixture.root,
        fixture.ignored
      )
    ).rejects.toThrow();
    await expect(
      readPrivateDestinationReceipt(
        join(fixture.root, "private", "deployment"),
        fixture.root,
        fixture.ignored
      )
    ).rejects.toThrow();
    await writeFile(fixture.path, "x".repeat(65_537));
    return await expect(
      readPrivateDestinationReceipt(fixture.path, fixture.root, fixture.ignored)
    ).rejects.toThrow();
  });

  return it("rejects a directory masquerading as a receipt", async () => {
    const fixture = await setup();
    const directory = join(fixture.root, "private", "deployment", "directory");
    await mkdir(directory, { mode: 0o600 });
    return await expect(
      readPrivateDestinationReceipt(directory, fixture.root, fixture.ignored)
    ).rejects.toThrow();
  });
});

describe("deployment runtime adapters", () => {
  it("is inert until invoked and pins Git object reads to the selected root and exact SHA", async () => {
    const fixture = await setup();
    const run = vi.mocked(execFileSync);
    run.mockReturnValue("");
    const deps = createWebDeploymentDependencies(fixture.root);
    expect(run).not.toHaveBeenCalled();
    expect(await deps.cleanTree()).toBe(true);
    run.mockReturnValueOnce(" M changed-file");
    expect(await deps.cleanTree()).toBe(false);
    run.mockReturnValueOnce(`${"b".repeat(40)}\n`);
    expect(await deps.currentHead()).toBe("b".repeat(40));
    expect(await deps.readReceipt(fixture.path)).toBe("{}");
    expect(run).toHaveBeenCalledWith(
      "git",
      ["check-ignore", "--quiet", "--", fixture.path],
      expect.objectContaining({ cwd: fixture.root })
    );
    await mkdir(join(fixture.root, "apps", "web"), { recursive: true });
    await writeFile(join(fixture.root, "apps", "web", "wrangler.jsonc"), "{}");
    run.mockReturnValueOnce("{}\n");
    expect(await deps.readConfiguration("b".repeat(40))).toBe("{}\n");
    expect(run).toHaveBeenLastCalledWith(
      "git",
      ["show", `${"b".repeat(40)}:apps/web/wrangler.jsonc`],
      expect.objectContaining({ cwd: fixture.root })
    );
    await expect(deps.readConfiguration("HEAD")).rejects.toThrow();
    return await expect(deps.assertAdapterInputs()).resolves.toBeUndefined();
  });

  it("fails closed when Git cannot establish ignored receipt status", async () => {
    const fixture = await setup();
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("synthetic Git failure");
    });
    const deps = createWebDeploymentDependencies(fixture.root);
    return await expect(deps.readReceipt(fixture.path)).rejects.toThrow();
  });

  it("constructs default-root adapters without invoking a command", () => {
    const deps = createWebDeploymentDependencies();
    expect(deps.source).not.toBe(process.env);
    expect(Object.isFrozen(deps.source)).toBe(true);
    expect(deps.output).toBe(process.stdout);
    expect(deps.errorOutput).toBe(process.stderr);
    return expect(execFileSync).not.toHaveBeenCalled();
  });

  it("does not share mutable parent environment state", () => {
    const environment = { CLOUDFLARE_ENV: "" };
    const deps = createWebDeploymentDependencies(undefined, environment);
    environment.CLOUDFLARE_ENV = "staging";
    return expect(deps.source["CLOUDFLARE_ENV"]).toBe("");
  });

  it("isolates successful runtime fixtures from the Corepack network selector used by the test harness", async () => {
    vi.stubEnv("COREPACK_ENABLE_NETWORK", "0");
    const harnessEnvironment = process.env;
    vi.mocked(execFileSync).mockReturnValue("");
    const deps = createWebDeploymentDependencies();
    expect(process.env).toBe(harnessEnvironment);
    expect(process.env["COREPACK_ENABLE_NETWORK"]).toBe("0");
    expect(deps.source["COREPACK_ENABLE_NETWORK"]).toBeUndefined();
    return expect(await deps.cleanTree()).toBe(true);
  });

  it("keeps the actual runtime invocable with informational Bun and package-manager launcher metadata", async () => {
    vi.mocked(execFileSync).mockReturnValue("");
    const deps = createWebDeploymentDependencies(undefined, {
      PATH: "/synthetic/bin",
      HOME: "/synthetic/home",
      CI: "1",
      NODE_ENV: "production",
      npm_config_user_agent: "bun/1.3.14",
      npm_config_local_prefix: "/synthetic/repo",
      COREPACK_ROOT: "/synthetic/corepack",
      PNPM_HOME: "/synthetic/pnpm",
    });
    expect(await deps.cleanTree()).toBe(true);
    return expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      expect.objectContaining({
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/nonexistent",
          LANG: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_NO_LAZY_FETCH: "1",
          GIT_ALLOW_PROTOCOL: "",
          GIT_TERMINAL_PROMPT: "0",
        },
      })
    );
  });

  it.each(["0", "1", ""])(
    "retains fail-closed handling when Corepack selection is explicitly part of the deployment environment %#",
    async (value) => {
      const deps = createWebDeploymentDependencies(undefined, {
        COREPACK_ENABLE_NETWORK: value,
      });
      await expect(deps.cleanTree()).rejects.toThrow(
        "deployment-input:ambient-selector"
      );
      expect(execFileSync).not.toHaveBeenCalled();
      return expect(spawn).not.toHaveBeenCalled();
    }
  );

  it.each(["production", "staging"])(
    "rejects an argument-only %s handoff without any preparation",
    async (environment) => {
      const fixture = await setup();
      const error = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const deps = createWebDeploymentDependencies(fixture.root);
      const before = await readdir(fixture.root);
      for (const mode of ["check", "deploy"]) {
        await writeFile(
          join(fixture.root, "changed-source.civet"),
          "unapproved source"
        );
        const adapterArgs = [
          "deploy",
          ...(mode === "check" ? ["--dry-run"] : []),
          ...(environment === "staging" ? ["--env", "staging"] : []),
        ];
        expect(
          await deps.deploy(
            adapterArgs as unknown as ApprovedRevisionDeploymentRequest
          )
        ).toBe(1);
      }
      expect(execFileSync).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('"phase":"admission"')
      );
      expect(spawn).not.toHaveBeenCalled();
      await rm(join(fixture.root, "changed-source.civet"));
      return expect(await readdir(fixture.root)).toEqual(before);
    }
  );

  it.each([
    ".env.production.local",
    ".env.local",
    ".env.production",
    ".env",
    ".dev.vars",
    ".dev.vars.production",
    ".dev.vars.staging",
  ])(
    "blocks ignored app-local %s without reading or disclosing values",
    async (name) => {
      const fixture = await setup();
      const app = join(fixture.root, "apps", "web");
      await mkdir(app, { recursive: true });
      await writeFile(join(app, "wrangler.jsonc"), "{}");
      await writeFile(
        join(app, name),
        "CLOUDFLARE_ENV=staging\nCLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=private-config.json\n"
      );
      const deps = createWebDeploymentDependencies(fixture.root);
      await expect(deps.assertAdapterInputs()).rejects.toThrow(
        "App-local dotenv and alternate adapter configuration inputs are unsupported"
      );
      return expect(execFileSync).not.toHaveBeenCalled();
    }
  );

  it.each([
    "wrangler.json",
    "wrangler.toml",
    "cloudflare.config.ts",
    ".wrangler/deploy/config.json",
  ])("rejects alternate config discovery at %s", async (name) => {
    const fixture = await setup();
    const app = join(fixture.root, "apps", "web");
    await mkdir(join(app, ".wrangler", "deploy"), { recursive: true });
    await writeFile(join(app, "wrangler.jsonc"), "{}");
    await writeFile(join(app, name), "{}");
    return await expect(
      createWebDeploymentDependencies(fixture.root).assertAdapterInputs()
    ).rejects.toThrow();
  });

  it("rejects symlinked dotenv, config, and app roots without following them", async () => {
    const fixture = await setup();
    const app = join(fixture.root, "apps", "web");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "wrangler.jsonc"), "{}");
    const dotenv = join(app, ".env");
    await symlink(join(fixture.root, "missing-private-file"), dotenv);
    const deps = createWebDeploymentDependencies(fixture.root);
    await expect(deps.assertAdapterInputs()).rejects.toThrow();
    await rm(dotenv);
    await rm(join(app, "wrangler.jsonc"));
    await symlink(fixture.path, join(app, "wrangler.jsonc"));
    await expect(deps.assertAdapterInputs()).rejects.toThrow();
    await rm(app, { recursive: true });
    await symlink(join(fixture.root, "private", "deployment"), app);
    await writeFile(
      join(fixture.root, "private", "deployment", "wrangler.jsonc"),
      "{}"
    );
    return await expect(deps.assertAdapterInputs()).rejects.toThrow();
  });

  it("fails closed on unexpected filesystem errors and missing/non-file configuration", async () => {
    const fixture = await setup();
    const deps = createWebDeploymentDependencies(fixture.root);
    await mkdir(join(fixture.root, "apps"));
    await writeFile(join(fixture.root, "apps", "web"), "not a directory");
    await expect(deps.assertAdapterInputs()).rejects.toThrow();
    await rm(join(fixture.root, "apps", "web"));
    await mkdir(join(fixture.root, "apps", "web"));
    await expect(deps.assertAdapterInputs()).rejects.toThrow();
    await mkdir(join(fixture.root, "apps", "web", "wrangler.jsonc"));
    return await expect(deps.assertAdapterInputs()).rejects.toThrow();
  });

  it.each(["production", "staging"])(
    "allows approved %s validation but rechecks admission and late dotenv for every mode",
    async (environment) => {
      const fixture = await setup();
      const app = join(fixture.root, "apps", "web");
      await mkdir(app, { recursive: true });
      const origin =
        environment === "staging"
          ? "https://staging.vertex.xyz"
          : "https://app.vertex.xyz";
      const name =
        environment === "staging"
          ? "vertex-research-web-staging"
          : "vertex-research-web";
      const selected = {
        account_id: "a".repeat(32),
        name,
        workers_dev: false,
        preview_urls: false,
        routes: [{ pattern: new URL(origin).hostname, custom_domain: true }],
        vars: {
          APP_ENV: "production",
          APP_URL: origin,
          BETTER_AUTH_URL: origin,
          EMAIL_PROVIDER: "disabled",
          EMAIL_TRANSPORT: "disabled",
        },
      };
      const config = JSON.stringify(
        environment === "staging" ? { env: { staging: selected } } : selected
      );
      await writeFile(join(app, "wrangler.jsonc"), config);
      const receipt = JSON.stringify({
        version: 1,
        environment,
        origin,
        workerName: name,
        accountFingerprint: createHash("sha256")
          .update("a".repeat(32))
          .digest("hex"),
        configurationSha256: createHash("sha256").update(config).digest("hex"),
        exactSha: "b".repeat(40),
        approvedBy: "synthetic-operator",
        accountVerified: true,
        domainVerified: true,
        cutoverApproved: true,
      });
      const runtime = createWebDeploymentDependencies(fixture.root);
      vi.mocked(execFileSync).mockReturnValue(" M unapproved-source.civet");
      const error = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const base = {
        ...runtime,
        source: {
          DATABASE_PROVIDER: "planetscale",
          DATABASE_URL:
            "postgresql://test:test@aws.pg.psdb.cloud:6432/isolated_test?sslmode=verify-full",
        },
        cleanTree: vi.fn(async () => true),
        currentHead: vi.fn(async () => "b".repeat(40)),
        readConfiguration: vi.fn(async () => config),
        readReceipt: vi.fn(async () => receipt),
        output: { write: vi.fn() },
        errorOutput: { write: vi.fn() },
      };
      const argumentsFor = (mode: string) => [
        "--environment",
        environment,
        "--destination-receipt",
        fixture.path,
        "--mode",
        mode,
      ];
      expect(await runWebDeploymentCli(argumentsFor("validate"), base)).toBe(0);
      for (const mode of ["check", "deploy"]) {
        const changedSource = join(app, "unapproved-source.civet");
        const deps = {
          ...base,
          deploy: vi.fn(async (request: ApprovedRevisionDeploymentRequest) => {
            // The concrete runtime independently denies post-CLI admission drift.
            await writeFile(changedSource, "unapproved source");
            return runtime.deploy(request);
          }),
        };
        try {
          expect(await runWebDeploymentCli(argumentsFor(mode), deps)).toBe(1);
          expect(deps.deploy).toHaveBeenCalledTimes(1);
        } finally {
          await rm(changedSource, { force: true });
        }
      }
      expect(error).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('"phase":"admission"')
      );
      for (const file of [
        ".env.production.local",
        ".env.local",
        ".env.production",
        ".env",
      ]) {
        for (const mode of ["validate", "check", "deploy"]) {
          const path = join(app, file);
          const deps = {
            ...base,
            readReceipt: vi.fn(async () => {
              await writeFile(
                path,
                "CLOUDFLARE_ENV=staging\nCLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=private-override\n"
              );
              return receipt;
            }),
            deploy: vi.fn(runtime.deploy),
            errorOutput: { write: vi.fn() },
          };
          try {
            expect(await runWebDeploymentCli(argumentsFor(mode), deps)).toBe(1);
            expect(deps.deploy).not.toHaveBeenCalled();
            expect(
              JSON.stringify(deps.errorOutput.write.mock.calls)
            ).not.toContain("private-override");
          } finally {
            await rm(path, { force: true });
          }
        }
      }
      return expect(spawn).not.toHaveBeenCalled();
    }
  );

  return it("rejects hardlinked private authority files", async () => {
    const fixture = await setup();
    await link(fixture.path, join(fixture.root, "second-receipt.json"));
    return await expect(
      readPrivateDestinationReceipt(fixture.path, fixture.root, fixture.ignored)
    ).rejects.toThrow();
  });
});
