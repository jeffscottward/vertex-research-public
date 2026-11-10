import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import {
  assertAmbientInputs,
  assertInputPath,
  assertSourcePath,
  destinationBinding,
  inputLimits,
  materializeApprovedSource,
  objectId,
  revalidateDestination,
  sha256,
  validateRequest,
  type ApprovedRevisionDeploymentRequest,
} from "./approved-inputs.ts";
import { syntheticEnvironment, syntheticRevision } from "./test-fixtures.ts";

const materialize = (fixture = syntheticRevision()) =>
  materializeApprovedSource(
    fixture.request,
    fixture.reader,
    syntheticEnvironment
  );

// Read current repository authority, not a reduced snapshot or a frozen digest.
// Feed those exact bytes through synthetic Git objects; destination approval is
// still synthetic and no Git, package manager, network or adapter is invoked.
const repositoryAuthority = async (): Promise<Record<string, string>> => {
  const root = new URL("../../", import.meta.url);
  const paths = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".nvmrc",
  ];
  for (const directory of ["apps", "packages"]) {
    for (const entry of await readdir(new URL(`${directory}/`, root), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory())
        paths.push(`${directory}/${entry.name}/package.json`);
    }
  }
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        await readFile(new URL(path, root), "utf8"),
      ])
    )
  );
};

describe("exact approved source objects", () => {
  it.each(["production", "staging"] as const)(
    "materializes %s from verified Git object bytes and preserves exact configuration",
    async (environment) => {
      const fixture = syntheticRevision(
        {
          "scripts/executable": "#!/bin/sh\n",
          ".env.example": "NOT_A_SECRET=example\n",
        },
        environment,
        { "scripts/executable": "100755" }
      );
      const result = await materialize(fixture);
      expect(result.exactSha).toBe(fixture.request.exactSha);
      expect(result.tree).toBe(fixture.treeId);
      expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.dependencyAuthoritySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(
        result.files.find((file) => file.path === "scripts/executable")?.mode
      ).toBe("100755");
      expect(Object.isFrozen(result.files)).toBe(true);
      const copied = result.files.find(
        (file) => file.path === "apps/web/wrangler.jsonc"
      )!;
      fixture.objects.get(copied.oid)?.fill(0);
      return expect(sha256(copied.bytes)).toBe(
        fixture.request.configurationSha256
      );
    }
  );

  it.each(["HEAD", "b".repeat(39), "B".repeat(40), "b".repeat(41), "--help"])(
    "rejects nonexact commit identities %#",
    (exactSha) => {
      const { request } = syntheticRevision();
      return expect(() => validateRequest({ ...request, exactSha })).toThrow();
    }
  );

  it.each(["exactSha", "configurationSha256", "environment"] as const)(
    "binds request field %s to the human receipt",
    (field) => {
      const { request } = syntheticRevision();
      const value =
        field === "environment"
          ? "staging"
          : "c".repeat(field === "exactSha" ? 40 : 64);
      return expect(() =>
        validateRequest({ ...request, [field]: value })
      ).toThrow("request-binding");
    }
  );

  it.each(["args", "cwd", "image", "mounts", "env", "executable"])(
    "rejects caller-controlled %s",
    (key) => {
      return expect(() =>
        validateRequest({
          ...syntheticRevision().request,
          [key]: "sentinel",
        } as ApprovedRevisionDeploymentRequest)
      ).toThrow("request-override");
    }
  );

  it.each([
    null,
    [],
    {},
    { approvedBy: "x".repeat(129) },
    { approvedBy: "line\nfeed" },
  ])("rejects malformed destination identities %#", (value) => {
    return expect(() => destinationBinding(value)).toThrow();
  });

  it("projects only known receipt fields without private arbitrary values", () => {
    const binding = destinationBinding({
      ...syntheticRevision().request.destinationBinding,
      secret: "sentinel",
    });
    expect(JSON.stringify(binding)).not.toContain("sentinel");
    return expect(Object.isFrozen(binding)).toBe(true);
  });

  it.each([
    "../escape",
    "/absolute",
    "a//b",
    "a/./b",
    "a/../b",
    "a\\b",
    "a\0b",
    "a\nb",
    "a:",
    "a.",
    "x".repeat(241),
  ])("rejects ambiguous source/archive paths %#", (path) => {
    return expect(() => assertInputPath(path)).toThrow("unsafe-path");
  });

  it.each([
    ".git/config",
    "private/approval.json",
    "node_modules/poison",
    ".env",
    "apps/web/.env.local",
    "apps/web/.dev.vars",
    "apps/web/wrangler.toml",
    "apps/web/wrangler.json",
    "apps/web/cloudflare.config.ts",
    "apps/web/vite.config.js",
    "apps/web/.wrangler/deploy/config.json",
    "apps/web/dist",
    ".npmrc",
    ".pnpmfile.cjs",
    ".next/cache",
    ".turbo/cache",
  ])("rejects implicit or generated inputs %s", (path) => {
    return expect(() => assertSourcePath(path)).toThrow();
  });

  it.each([
    ".env.example",
    ".env.schema",
    "apps/web/src/app/(portal)/[id]/page.civet",
    "packages/shared/package.json",
  ])("accepts reviewed monorepo path %s", (path) => {
    return expect(() => assertSourcePath(path)).not.toThrow();
  });

  it.each([
    "GIT_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_CONFIG_COUNT",
    "NODE_OPTIONS",
    "NODE_PATH",
    "npm_config_registry",
    "PNPM_STORE_DIR",
    "COREPACK_INTEGRITY_KEYS",
    "DOCKER_HOST",
    "BUILDKIT_HOST",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "BASH_ENV",
    "ENV",
    "CLOUDFLARE_ENV",
    "WRANGLER_ENV",
    "CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH",
    "CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT",
    "WRANGLER_CI_OVERRIDE_NAME",
  ])("rejects even empty ambient selector %s", (key) => {
    expect(() => assertAmbientInputs({ [key]: "" })).toThrow(
      "ambient-selector"
    );
    return expect(() =>
      assertAmbientInputs({ [key]: undefined })
    ).not.toThrow();
  });

  it("keeps ordinary environment data separate from selector rejection", () =>
    expect(() =>
      assertAmbientInputs({
        NODE_ENV: "test",
        DATABASE_URL: "sentinel",
        HTTP_PROXY: "not forwarded",
      })
    ).not.toThrow());

  it.each(["commit", "tree", "blob"] as const)(
    "rejects corrupted %s bytes",
    async (kind) => {
      const fixture = syntheticRevision();
      const reader = {
        read: async (requested: "commit" | "tree" | "blob", oid: string) =>
          requested === kind
            ? Buffer.from("corrupt")
            : fixture.reader.read(requested, oid),
      };
      return await expect(
        materializeApprovedSource(fixture.request, reader, syntheticEnvironment)
      ).rejects.toThrow("object-integrity");
    }
  );

  it("rejects oversized object buffers before accepting their contents", async () => {
    const fixture = syntheticRevision();
    return await expect(
      materializeApprovedSource(
        fixture.request,
        { read: async () => Buffer.alloc(inputLimits.tree + 1) },
        syntheticEnvironment
      )
    ).rejects.toThrow("object-integrity");
  });

  it("bounds recursive Git trees without relying on filesystem traversal", async () =>
    await expect(
      materialize(
        syntheticRevision({ [`${"deep/".repeat(33)}file`]: "bounded" })
      )
    ).rejects.toThrow("tree-depth"));

  it.each(["120000", "160000", "100664"])(
    "rejects source links/submodules/unreviewed mode %s",
    async (mode) => {
      return await expect(
        materialize(
          syntheticRevision({ link: "outside" }, "production", { link: mode })
        )
      ).rejects.toThrow("source-link-or-mode");
    }
  );

  it("rejects case-folded file collisions", async () =>
    await expect(
      materialize(syntheticRevision({ Case: "one", case: "two" }))
    ).rejects.toThrow("tree-collision"));

  it("requires a source configuration and complete dependency authority", async () => {
    await expect(
      materialize(syntheticRevision({ "apps/web/wrangler.jsonc": null }))
    ).rejects.toThrow("missing-configuration");
    for (const path of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".nvmrc",
      "infra/docker/deployment/policy.json",
    ]) {
      await expect(
        materialize(syntheticRevision({ [path]: null }))
      ).rejects.toThrow("dependency-authority");
    }
  });

  it.each([
    "file:../foreign",
    "link:../foreign",
    "git+https://example.invalid/repo",
    "https://example.invalid/package.tgz",
    "github:owner/repo",
    "/host/path",
  ])("rejects unsupported acquisition %s", async (version) => {
    return await expect(
      materialize(
        syntheticRevision({
          "apps/web/package.json": JSON.stringify({
            dependencies: { unsafe: version },
          }),
        })
      )
    ).rejects.toThrow("unsupported-acquisition");
  });

  it("permits isolated workspace dependencies but rejects lockfile tarball sources", async () => {
    await expect(
      materialize(
        syntheticRevision({
          "apps/web/package.json": JSON.stringify({
            dependencies: { shared: "workspace:*", vite: "catalog:" },
          }),
        })
      )
    ).resolves.toBeDefined();
    return await expect(
      materialize(
        syntheticRevision({
          "pnpm-lock.yaml":
            "resolution: {tarball: https://example.invalid/unsafe}\n",
        })
      )
    ).rejects.toThrow("unsupported-lock-acquisition");
  });

  it("changes manifest and dependency identities for changed authority bytes", async () => {
    const before = await materialize();
    const after = await materialize(
      syntheticRevision({
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n# changed\n",
      })
    );
    expect(after.manifestSha256).not.toBe(before.manifestSha256);
    return expect(after.dependencyAuthoritySha256).not.toBe(
      before.dependencyAuthoritySha256
    );
  });

  it("accepts exact current repository lock/workspace/manifests including excludeLinksFromLockfile and every contained importer link", async () => {
    const authority = await repositoryAuthority();
    expect(authority["pnpm-lock.yaml"]).toContain(
      "excludeLinksFromLockfile: false"
    );
    expect(authority["pnpm-lock.yaml"]).toContain("version: link:");
    expect(
      Object.keys(authority).filter((path) => path.endsWith("package.json"))
        .length
    ).toBeGreaterThan(2);
    const result = await materialize(syntheticRevision(authority));
    for (const [path, bytes] of Object.entries(authority)) {
      expect(
        result.files.find((file) => file.path === path)?.bytes.toString("utf8")
      ).toBe(bytes);
    }
  });

  it("does not mistake protocol text in comments or package deprecation metadata for dependency acquisition", async () => {
    const lock = `lockfileVersion: '9.0'\nsettings: {autoInstallPeers: true, excludeLinksFromLockfile: false}\n# file: tarball: git+https: registry: are not acquisition instructions\npackages:\n  safe@1.0.0:\n    resolution: {integrity: sha512-${"A".repeat(86)}==}\n    deprecated: 'file: in this note is ordinary metadata'\n`;
    await expect(
      materialize(syntheticRevision({ "pnpm-lock.yaml": lock }))
    ).resolves.toBeDefined();
    const decodedKey =
      'lockfileVersion: "9.0"\nsettings: {"excludeLinksFromLockfi\\u006ce": false}\n';
    return await expect(
      materialize(syntheticRevision({ "pnpm-lock.yaml": decodedKey }))
    ).resolves.toBeDefined();
  });

  it.each([
    "excludeLinksFromLockfileTarball",
    "excludeLinksFromLockfileRegistry",
    "registry",
    "@private:registry",
  ])(
    "does not treat nearby setting key %s as normal lock metadata",
    async (key) => {
      const lock = JSON.stringify({
        lockfileVersion: "9.0",
        settings: { excludeLinksFromLockfile: false, [key]: false },
      });
      return await expect(
        materialize(syntheticRevision({ "pnpm-lock.yaml": lock }))
      ).rejects.toThrow("unsupported-lock-acquisition");
    }
  );

  it.each([
    "file:../outside.tgz",
    "link:../outside",
    "git+ssh://example.invalid/repo",
    "git+https://example.invalid/repo",
    "ssh://example.invalid/repo",
    "https://private.invalid/package.tgz",
    "../outside",
    "/outside",
    "owner/repo",
    "npm:safe@file:../outside",
    "npm:safe@git+https://example.invalid/repo",
  ])(
    "rejects acquisition value %s in decoded lock catalogs and overrides",
    async (value) => {
      for (const section of [
        { overrides: { safe: value } },
        {
          catalogs: {
            default: { safe: { specifier: value, version: "1.0.0" } },
          },
        },
        { snapshots: { "safe@1.0.0": { dependencies: { bad: value } } } },
      ]) {
        const lock = JSON.stringify({ lockfileVersion: "9.0", ...section });
        await expect(
          materialize(syntheticRevision({ "pnpm-lock.yaml": lock }))
        ).rejects.toThrow("unsupported-lock-acquisition");
      }
    }
  );

  it.each(["tarball", "registry", "repo", "commit", "directory", "type"])(
    "rejects explicit resolution key %s even alongside valid integrity",
    async (key) => {
      const lock = JSON.stringify({
        lockfileVersion: "9.0",
        packages: {
          "safe@1.0.0": {
            resolution: {
              integrity: `sha512-${"A".repeat(86)}==`,
              [key]: "private-value",
            },
          },
        },
      });
      return await expect(
        materialize(syntheticRevision({ "pnpm-lock.yaml": lock }))
      ).rejects.toThrow("unsupported-lock-acquisition");
    }
  );

  it("approves only reviewed build scripts while accepting explicit build denials", async () => {
    for (const allowBuilds of [
      { postinstaller: true },
      { esbuild: "true" },
      { esbuild: null },
    ]) {
      await expect(
        materialize(
          syntheticRevision({
            "pnpm-workspace.yaml": JSON.stringify({
              packages: ["apps/*", "packages/*"],
              allowBuilds,
            }),
          })
        )
      ).rejects.toThrow("unsupported-lock-acquisition");
    }
    return await expect(
      materialize(
        syntheticRevision({
          "pnpm-workspace.yaml": JSON.stringify({
            packages: ["apps/*", "packages/*"],
            allowBuilds: { esbuild: true, "@scarf/scarf": false },
          }),
        })
      )
    ).resolves.toBeDefined();
  });

  it("accepts enableGlobalVirtualStore only as false", async () => {
    const workspace = (enableGlobalVirtualStore: unknown): string =>
      JSON.stringify({
        packages: ["apps/*", "packages/*"],
        enableGlobalVirtualStore,
      });
    for (const value of [true, "false", null, 0]) {
      await expect(
        materialize(
          syntheticRevision({ "pnpm-workspace.yaml": workspace(value) })
        )
      ).rejects.toThrow("unsupported-lock-acquisition");
    }
    return await expect(
      materialize(
        syntheticRevision({ "pnpm-workspace.yaml": workspace(false) })
      )
    ).resolves.toBeDefined();
  });

  it("accepts verifyDepsBeforeRun only as error", async () => {
    const workspace = (verifyDepsBeforeRun: unknown): string =>
      JSON.stringify({
        packages: ["apps/*", "packages/*"],
        verifyDepsBeforeRun,
      });
    for (const value of ["install", "warn", "prompt", false, true, null]) {
      await expect(
        materialize(
          syntheticRevision({ "pnpm-workspace.yaml": workspace(value) })
        )
      ).rejects.toThrow("unsupported-lock-acquisition");
    }
    return await expect(
      materialize(
        syntheticRevision({ "pnpm-workspace.yaml": workspace("error") })
      )
    ).resolves.toBeDefined();
  });

  it("accepts minimumReleaseAgeExclude only as registry version strings", async () => {
    const workspace = (minimumReleaseAgeExclude: unknown): string =>
      JSON.stringify({
        packages: ["apps/*", "packages/*"],
        minimumReleaseAgeExclude,
      });
    for (const value of ["esbuild", { esbuild: true }, ["../outside"], [7]]) {
      await expect(
        materialize(
          syntheticRevision({ "pnpm-workspace.yaml": workspace(value) })
        )
      ).rejects.toThrow("unsupported-lock-acquisition");
    }
    return await expect(
      materialize(
        syntheticRevision({
          "pnpm-workspace.yaml": workspace(["esbuild", "@scope/pkg@1.2.3"]),
        })
      )
    ).resolves.toBeDefined();
  });

  it.each([
    {},
    { integrity: "sha512-short" },
    { integrity: `sha1-${"A".repeat(28)}` },
    { integrity: 42 },
  ])(
    "requires a full registry package SHA512 integrity pin %#",
    async (resolution) => {
      const lock = JSON.stringify({
        lockfileVersion: "9.0",
        packages: { "safe@1.0.0": { resolution } },
      });
      return await expect(
        materialize(syntheticRevision({ "pnpm-lock.yaml": lock }))
      ).rejects.toThrow("unsupported-lock-acquisition");
    }
  );

  it("decodes escaped protocol values and quoted resolver keys before applying policy", async () => {
    const escaped =
      'lockfileVersion: "9.0"\noverrides:\n  safe: "fi\\u006ce:../outside"\n';
    const key = `lockfileVersion: '9.0'\npackages:\n  safe@1.0.0:\n    resolution:\n      "tar\\u0062all": "https://private.invalid/pkg.tgz"\n`;
    for (const lock of [escaped, key]) {
      await expect(
        materialize(syntheticRevision({ "pnpm-lock.yaml": lock }))
      ).rejects.toThrow("unsupported-lock-acquisition");
    }
  });

  it.each([
    "lockfileVersion: '9.0'\nsettings: {excludeLinksFromLockfile: false, excludeLinksFromLockfile: true}\n",
    "lockfileVersion: '9.0'\n---\nlockfileVersion: '9.0'\n",
    "lockfileVersion: !unsafe '9.0'\n",
    "lockfileVersion: !!str '9.0'\n",
    "lockfileVersion: &version '9.0'\nsettings: {excludeLinksFromLockfile: *version}\n",
    "lockfileVersion: '9.0'\n? [complex, key]\n: value\n",
    "lockfileVersion: '9.0'\nsettings: [false]\n",
    "lockfileVersion: '9.0'\npackages: []\n",
    "lockfileVersion: '9.0'\noverrides: {safe: 12}\n",
    "lockfileVersion: '9.0'\nsettings: {excludeLinksFromLockfile: 'false'}\n",
    "lockfileVersion: [",
    " ".repeat(2_097_153),
    JSON.stringify({
      lockfileVersion: "9.0",
      overrides: { safe: Array.from({ length: 100_001 }, () => 1) },
    }),
    "lockfileVersion: '9.0'\nsettings: " +
      "[".repeat(50) +
      "false" +
      "]".repeat(50),
  ])(
    "rejects malformed, ambiguous, aliased or unbounded authority YAML %#",
    async (lock) => {
      return await expect(
        materialize(syntheticRevision({ "pnpm-lock.yaml": lock }))
      ).rejects.toThrow("unsupported-lock-acquisition");
    }
  );

  it.each([
    "link:/packages/shared",
    "link:../../../outside",
    "link:../../packages/missing",
    "link:../../private/shared",
    "link:../../packages/shared\\escape",
  ])(
    "denies unsafe importer link %s while preserving real workspace links",
    async (version) => {
      const authority = await repositoryAuthority();
      const changed = authority["pnpm-lock.yaml"]!.replace(
        /version: link:[^\n]+/,
        `version: ${JSON.stringify(version)}`
      );
      expect(changed).not.toBe(authority["pnpm-lock.yaml"]);
      return await expect(
        materialize(
          syntheticRevision({ ...authority, "pnpm-lock.yaml": changed })
        )
      ).rejects.toThrow("unsupported-lock-acquisition");
    }
  );

  it("requires linked package names and workspace declarations to match the committed importer authority", async () => {
    const authority = await repositoryAuthority();
    const changed = authority["pnpm-lock.yaml"]!.replace(
      "version: link:packages/api",
      "version: link:packages/shared"
    );
    expect(changed).not.toBe(authority["pnpm-lock.yaml"]);
    await expect(
      materialize(
        syntheticRevision({ ...authority, "pnpm-lock.yaml": changed })
      )
    ).rejects.toThrow("unsupported-lock-acquisition");
    const manifest = JSON.parse(authority["package.json"]!) as {
      devDependencies: Record<string, string>;
    };
    manifest.devDependencies["@darkfactory/api"] = "^1.0.0";
    return await expect(
      materialize(
        syntheticRevision({
          ...authority,
          "package.json": JSON.stringify(manifest),
        })
      )
    ).rejects.toThrow("unsupported-lock-acquisition");
  });

  it.each([
    "registry",
    "registries",
    "packageExtensions",
    "patchedDependencies",
    "pnpmfile",
    "configDependencies",
  ])(
    "denies unreviewed workspace replacement/configuration key %s",
    async (key) => {
      const workspace = JSON.stringify({
        packages: ["apps/*", "packages/*"],
        [key]: { safe: "https://private.invalid" },
      });
      return await expect(
        materialize(syntheticRevision({ "pnpm-workspace.yaml": workspace }))
      ).rejects.toThrow("unsupported-lock-acquisition");
    }
  );

  it("checks workspace catalogs, overrides and manifest pnpm overrides as acquisition authority", async () => {
    for (const field of ["catalog", "overrides"]) {
      const workspace = JSON.stringify({
        packages: ["apps/*", "packages/*"],
        [field]: { safe: "file:../outside" },
      });
      await expect(
        materialize(syntheticRevision({ "pnpm-workspace.yaml": workspace }))
      ).rejects.toThrow("unsupported-lock-acquisition");
    }
    const pkg = JSON.stringify({
      pnpm: { overrides: { safe: "npm:safe@https://private.invalid" } },
    });
    await expect(
      materialize(syntheticRevision({ "apps/web/package.json": pkg }))
    ).rejects.toThrow("unsupported-acquisition");
    return await expect(
      materialize(
        syntheticRevision({
          "apps/web/package.json": JSON.stringify({
            dependencies: { alias: "npm:@scope/safe@^1.2.3" },
          }),
        })
      )
    ).resolves.toBeDefined();
  });

  it("revalidates config trailing bytes, human authority, destination and database", () => {
    const fixture = syntheticRevision();
    const bytes = Buffer.from(fixture.files["apps/web/wrangler.jsonc"]!);
    expect(() =>
      revalidateDestination(
        fixture.request,
        Buffer.concat([bytes, Buffer.from("\n")]),
        syntheticEnvironment
      )
    ).toThrow("configuration-drift");
    expect(() =>
      revalidateDestination(
        {
          ...fixture.request,
          destinationBinding: {
            ...fixture.request.destinationBinding,
            cutoverApproved: false,
          },
        } as unknown as ApprovedRevisionDeploymentRequest,
        bytes,
        syntheticEnvironment
      )
    ).toThrow("destination");
    expect(() => revalidateDestination(fixture.request, bytes, {})).toThrow(
      "database"
    );
    return expect(() =>
      revalidateDestination(fixture.request, bytes, {
        ...syntheticEnvironment,
        CF_ACCOUNT_ID: "b".repeat(32),
      })
    ).toThrow("destination");
  });

  return it("rejects verified malformed tree and missing commit-tree records", async () => {
    for (const contents of ["not-a-tree\n", `tree ${"a".repeat(40)}\n`]) {
      const fixture = syntheticRevision();
      const commit = Buffer.from(contents);
      const exactSha = objectId("commit", commit);
      const request = {
        ...fixture.request,
        exactSha,
        destinationBinding: { ...fixture.request.destinationBinding, exactSha },
      };
      const malformed = Buffer.from("100644 missing-null");
      const tree = objectId("tree", malformed);
      const actualCommit = contents.startsWith("tree")
        ? Buffer.from(`tree ${tree}\n`)
        : commit;
      const actualSha = objectId("commit", actualCommit);
      await expect(
        materializeApprovedSource(
          {
            ...request,
            exactSha: actualSha,
            destinationBinding: {
              ...request.destinationBinding,
              exactSha: actualSha,
            },
          },
          {
            read: async (kind) =>
              kind === "commit" ? actualCommit : malformed,
          },
          syntheticEnvironment
        )
      ).rejects.toThrow();
    }
  });
});
