import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parseDocument } from "yaml";
import type { DeploymentEnvironment } from "./database.ts";
import { checkProductionWebDatabaseEndpoint } from "./database.ts";
import {
  checkWebDeploymentDestination,
  parseWranglerConfiguration,
  type WebDeploymentEnvironment,
} from "./destination.ts";

export type DestinationBinding = Readonly<{
  version: 1;
  environment: WebDeploymentEnvironment;
  workerName: string;
  origin: string;
  accountFingerprint: string;
  configurationSha256: string;
  exactSha: string;
  approvedBy: string;
  accountVerified: true;
  domainVerified: true;
  cutoverApproved: true;
}>;
export type ApprovedRevisionDeploymentRequest = Readonly<{
  exactSha: string;
  configurationSha256: string;
  environment: WebDeploymentEnvironment;
  mode: "check" | "deploy";
  destinationBinding: DestinationBinding;
}>;
export type GitObjectReader = Readonly<{
  read: (kind: "commit" | "tree" | "blob", oid: string) => Promise<Buffer>;
}>;
export type SourceFile = Readonly<{
  path: string;
  mode: "100644" | "100755";
  oid: string;
  sha256: string;
  bytes: Buffer;
}>;
export type ApprovedSource = Readonly<{
  exactSha: string;
  tree: string;
  manifestSha256: string;
  dependencyAuthoritySha256: string;
  files: readonly SourceFile[];
}>;

export const inputLimits = Object.freeze({
  files: 20_000,
  blob: 16_777_216,
  total: 268_435_456,
  tree: 4_194_304,
  depth: 32,
});
export const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export const objectId = (kind: string, bytes: Buffer): string =>
  createHash("sha1")
    .update(`${kind} ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
export const inputFailure: (code: string) => never = (code) => {
  throw new Error(`deployment-input:${code}`);
};

export const assertInputPath = (path: string): void => {
  if (
    path.length > 240 ||
    !/^[A-Za-z0-9_@.+/()[\],=-]+$/.test(path) ||
    path
      .split("/")
      .some(
        (part) => !part || part === "." || part === ".." || part.endsWith(".")
      )
  ) {
    inputFailure("unsafe-path");
  }
};

export const assertSourcePath = (path: string): void => {
  assertInputPath(path);
  const parts = path.split("/");
  if (
    parts.some(
      (part) =>
        [
          ".git",
          "private",
          "node_modules",
          ".wrangler",
          ".next",
          ".turbo",
          ".cache",
          ".npmrc",
          ".pnpmfile.cjs",
        ].includes(part) ||
        (/^\.env(?:\.|$)/.test(part) &&
          ![".env.example", ".env.schema"].includes(part)) ||
        /^\.dev\.vars(?:\.|$)/.test(part)
    )
  ) {
    inputFailure("implicit-source-input");
  }
  if (
    /^apps\/web\/(?:dist(?:\/|$)|wrangler\.(?:json|toml)$|cloudflare\.config\.ts$|vite\.config\.(?:js|mjs|mts|cjs|cts)$)/.test(
      path
    )
  ) {
    inputFailure("implicit-adapter-input");
  }
};

export const assertAmbientInputs = (source: DeploymentEnvironment): void => {
  for (const key of Object.keys(source)) {
    // Launcher metadata is not forwarded, but must not make the existing Bun
    // aliases impossible to invoke. Configuration/loader selectors still deny.
    if (
      [
        "NODE_ENV",
        "npm_config_user_agent",
        "NPM_CONFIG_USER_AGENT",
        "npm_config_local_prefix",
        "PNPM_HOME",
        "COREPACK_ROOT",
      ].includes(key)
    )
      continue;
    if (
      source[key] !== undefined &&
      (/^(?:GIT_|NODE_|BUN_OPTIONS$|NPM_CONFIG_|npm_config_|PNPM_|COREPACK_|DOCKER_|BUILDKIT_|LD_|DYLD_|BASH_ENV$|ENV$)/.test(
        key
      ) ||
        [
          "CLOUDFLARE_ENV",
          "WRANGLER_ENV",
          "CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH",
          "CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT",
          "CLOUDFLARE_VITE_BUILD",
          "WRANGLER_CI_OVERRIDE_NAME",
        ].includes(key))
    ) {
      inputFailure("ambient-selector");
    }
  }
};

export const destinationBinding = (value: unknown): DestinationBinding => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    inputFailure("binding");
  const r = value as Record<string, unknown>;
  const keys = [
    "version",
    "environment",
    "workerName",
    "origin",
    "accountFingerprint",
    "configurationSha256",
    "exactSha",
    "approvedBy",
    "accountVerified",
    "domainVerified",
    "cutoverApproved",
  ];
  if (
    keys.some((key) => r[key] === undefined) ||
    typeof r["approvedBy"] !== "string" ||
    r["approvedBy"].length > 128 ||
    /[\x00-\x1f\x7f]/.test(r["approvedBy"])
  )
    inputFailure("binding");
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, r[key]]))
  ) as DestinationBinding;
};

export const validateRequest = (
  request: ApprovedRevisionDeploymentRequest
): void => {
  if (
    !(
      request &&
      /^[a-f0-9]{40}$/.test(request.exactSha) &&
      /^[a-f0-9]{64}$/.test(request.configurationSha256) &&
      ["production", "staging"].includes(request.environment) &&
      ["check", "deploy"].includes(request.mode)
    )
  )
    inputFailure("request");
  if (
    Object.keys(request).some(
      (key) =>
        ![
          "exactSha",
          "configurationSha256",
          "environment",
          "mode",
          "destinationBinding",
        ].includes(key)
    )
  )
    inputFailure("request-override");
  const binding = destinationBinding(request.destinationBinding);
  if (
    binding.exactSha !== request.exactSha ||
    binding.configurationSha256 !== request.configurationSha256 ||
    binding.environment !== request.environment
  )
    inputFailure("request-binding");
};

export const revalidateDestination = (
  request: ApprovedRevisionDeploymentRequest,
  configuration: Buffer,
  environment: DeploymentEnvironment
): void => {
  validateRequest(request);
  assertAmbientInputs(environment);
  if (
    configuration.length > 65_536 ||
    sha256(configuration) !== request.configurationSha256
  )
    inputFailure("configuration-drift");
  let config: unknown;
  try {
    config = parseWranglerConfiguration(configuration.toString("utf8"));
  } catch {
    inputFailure("configuration-json");
  }
  const result = checkWebDeploymentDestination(
    {
      environment: request.environment,
      config,
      verification: request.destinationBinding,
      headSha: request.exactSha,
    },
    environment
  );
  if (!result.ok) inputFailure("destination");
  if (!checkProductionWebDatabaseEndpoint(environment).ok)
    inputFailure("database");
};

const authorityRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

// Bounded data only: no aliases, duplicate keys, tags or multiple documents.
const authorityYaml = (bytes: Buffer): Record<string, unknown> => {
  if (bytes.length > 2_097_152) inputFailure("unsupported-lock-acquisition");
  try {
    const document = parseDocument(bytes.toString("utf8"), {
      schema: "core",
      uniqueKeys: true,
      strict: true,
    });
    if (document.errors.length || document.warnings.length)
      inputFailure("unsupported-lock-acquisition");
    let nodes = 0;
    const inspect = (node: unknown, depth: number): void => {
      if (node === null || node === undefined) return;
      if (++nodes > 100_000 || depth > 48 || typeof node !== "object")
        inputFailure("unsupported-lock-acquisition");
      const item = node as {
        tag?: string;
        source?: unknown;
        value?: unknown;
        items?: unknown[];
        key?: unknown;
      };
      if (
        item.tag ||
        ("source" in item && !("value" in item) && !("items" in item))
      )
        inputFailure("unsupported-lock-acquisition");
      if (item.items) {
        for (const child of item.items) {
          if (typeof child === "object" && child !== null && "key" in child) {
            const pair = child as { key: { value?: unknown }; value?: unknown };
            if (typeof pair.key?.value !== "string")
              inputFailure("unsupported-lock-acquisition");
            inspect(pair.key, depth + 1);
            inspect(pair.value, depth + 1);
          } else inspect(child, depth + 1);
        }
      }
    };
    inspect(document.contents, 0);
    const parsed: unknown = document.toJS({
      maxAliasCount: 0,
      mapAsMap: false,
    });
    if (!authorityRecord(parsed)) inputFailure("unsupported-lock-acquisition");
    return parsed;
  } catch {
    return inputFailure("unsupported-lock-acquisition");
  }
};

const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const registryVersion = (value: unknown): value is string => {
  // Colon/backslash and path prefixes cannot hide in versions or peer suffixes.
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    value === value.trim() &&
    /^[a-z0-9*^~<>=|()._+@/ -]+$/i.test(value) &&
    !/^(?:\.|\/)/.test(value) &&
    !value.replace(/@[a-z0-9._-]+\/[a-z0-9._-]+/gi, "scoped").includes("/")
  );
};

const dependencySpecifier = (value: unknown): boolean => {
  if (typeof value !== "string" || /^git/i.test(value)) return false;
  if (
    /^workspace:(?:\*|\^|~)$/.test(value) ||
    /^catalog:[a-z0-9_-]*$/i.test(value)
  )
    return true;
  if (value.startsWith("npm:")) {
    const alias = /^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(.+)$/i.exec(value);
    return !!alias && registryVersion(alias[2]);
  }
  return registryVersion(value);
};

const validateDependencyAuthority = (files: readonly SourceFile[]): void => {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const read = (path: string): Buffer => {
    const file = byPath.get(path);
    if (!file) inputFailure("dependency-authority");
    return file.bytes;
  };
  const manifests = new Map<string, Record<string, unknown>>();
  const dependencies = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ];
  const specifiers = (value: unknown, code: string): void => {
    if (!authorityRecord(value)) inputFailure(code);
    for (const [name, version] of Object.entries(value)) {
      if (
        !name ||
        name.length > 4096 ||
        /[:\\]/.test(name) ||
        !dependencySpecifier(version)
      )
        inputFailure(code);
    }
  };
  for (const file of files.filter((item) =>
    /(?:^|\/)package\.json$/.test(item.path)
  )) {
    const pkg: unknown = JSON.parse(file.bytes.toString("utf8"));
    if (!authorityRecord(pkg)) inputFailure("dependency-manifest");
    manifests.set(posix.dirname(file.path), pkg);
    for (const group of dependencies) {
      if (pkg[group] !== undefined)
        specifiers(pkg[group], "unsupported-acquisition");
    }
    if (pkg["pnpm"] !== undefined) {
      if (
        !authorityRecord(pkg["pnpm"]) ||
        Object.keys(pkg["pnpm"]).some((key) => key !== "overrides")
      )
        inputFailure("unsupported-acquisition");
      if (pkg["pnpm"]["overrides"] !== undefined)
        specifiers(pkg["pnpm"]["overrides"], "unsupported-acquisition");
    }
  }
  const workspace = authorityYaml(read("pnpm-workspace.yaml"));
  if (
    Object.keys(workspace).some(
      (key) =>
        ![
          "packages",
          "allowBuilds",
          "overrides",
          "catalog",
          "catalogs",
          "minimumReleaseAgeExclude",
          "enableGlobalVirtualStore",
          "verifyDepsBeforeRun",
        ].includes(key)
    )
  )
    inputFailure("unsupported-lock-acquisition");
  const workspacePaths = workspace["packages"];
  if (
    !Array.isArray(workspacePaths) ||
    workspacePaths.length !== 2 ||
    !workspacePaths.includes("apps/*") ||
    !workspacePaths.includes("packages/*")
  )
    inputFailure("unsupported-lock-acquisition");
  if (
    workspace["minimumReleaseAgeExclude"] !== undefined &&
    (!Array.isArray(workspace["minimumReleaseAgeExclude"]) ||
      workspace["minimumReleaseAgeExclude"].some(
        (value) => !registryVersion(value)
      ))
  )
    inputFailure("unsupported-lock-acquisition");
  // `false` keeps the project-local virtual store that pnpm uses anyway; the
  // pin only makes CI and local shells record the same workspace state.
  if (
    workspace["enableGlobalVirtualStore"] !== undefined &&
    workspace["enableGlobalVirtualStore"] !== false
  )
    inputFailure("unsupported-lock-acquisition");
  // `error` makes `pnpm run`/`pnpm exec` stop on stale dependencies instead of
  // installing, so it adds no acquisition path.
  if (
    workspace["verifyDepsBeforeRun"] !== undefined &&
    workspace["verifyDepsBeforeRun"] !== "error"
  )
    inputFailure("unsupported-lock-acquisition");
  // Only the three reviewed build scripts may be approved. An explicit
  // `false` entry is a denial (pnpm skips that package's install script), so
  // it never grants build authority and is accepted for any package name.
  if (
    workspace["allowBuilds"] !== undefined &&
    (!authorityRecord(workspace["allowBuilds"]) ||
      Object.entries(workspace["allowBuilds"]).some(
        ([name, allowed]) =>
          allowed !== false &&
          (!["esbuild", "sharp", "workerd"].includes(name) || allowed !== true)
      ))
  )
    inputFailure("unsupported-lock-acquisition");
  for (const key of ["overrides", "catalog"]) {
    if (workspace[key] !== undefined)
      specifiers(workspace[key], "unsupported-lock-acquisition");
  }
  if (workspace["catalogs"] !== undefined) {
    if (!authorityRecord(workspace["catalogs"]))
      inputFailure("unsupported-lock-acquisition");
    for (const catalog of Object.values(workspace["catalogs"]))
      specifiers(catalog, "unsupported-lock-acquisition");
  }
  const lock = authorityYaml(read("pnpm-lock.yaml"));
  if (
    lock["lockfileVersion"] !== "9.0" ||
    Object.keys(lock).some(
      (key) =>
        ![
          "lockfileVersion",
          "settings",
          "catalogs",
          "overrides",
          "importers",
          "packages",
          "snapshots",
        ].includes(key)
    )
  )
    inputFailure("unsupported-lock-acquisition");
  if (
    lock["settings"] !== undefined &&
    (!authorityRecord(lock["settings"]) ||
      Object.entries(lock["settings"]).some(
        ([key, value]) =>
          !["autoInstallPeers", "excludeLinksFromLockfile"].includes(key) ||
          typeof value !== "boolean"
      ))
  )
    inputFailure("unsupported-lock-acquisition");
  if (lock["overrides"] !== undefined)
    specifiers(lock["overrides"], "unsupported-lock-acquisition");
  for (const section of ["importers", "catalogs", "packages", "snapshots"]) {
    if (lock[section] !== undefined && !authorityRecord(lock[section]))
      inputFailure("unsupported-lock-acquisition");
  }
  for (const [importer, value] of Object.entries(
    (lock["importers"] ?? {}) as Record<string, unknown>
  )) {
    if (importer !== "." && !/^(?:apps|packages)\/[a-z0-9_-]+$/i.test(importer))
      inputFailure("unsupported-lock-acquisition");
    const pkg = manifests.get(importer);
    if (
      !(pkg && authorityRecord(value)) ||
      Object.keys(value).some((key) => !dependencies.includes(key))
    )
      inputFailure("unsupported-lock-acquisition");
    for (const [group, records] of Object.entries(value)) {
      if (!authorityRecord(records))
        inputFailure("unsupported-lock-acquisition");
      for (const [name, entry] of Object.entries(records)) {
        if (
          !(packageName.test(name) && authorityRecord(entry)) ||
          Object.keys(entry).some(
            (key) => !["specifier", "version"].includes(key)
          ) ||
          !dependencySpecifier(entry["specifier"]) ||
          typeof entry["version"] !== "string"
        )
          inputFailure("unsupported-lock-acquisition");
        const version = entry["version"];
        if (version.startsWith("link:")) {
          const relative = version.slice(5);
          if (!/^[a-z0-9_./-]+$/i.test(relative) || relative.startsWith("/"))
            inputFailure("unsupported-lock-acquisition");
          const target = posix.normalize(posix.join(importer, relative));
          const targetManifest = manifests.get(target);
          const declarations = pkg[group];
          if (
            !(
              /^(?:apps|packages)\/[a-z0-9_-]+$/i.test(target) && targetManifest
            ) ||
            targetManifest["name"] !== name ||
            !authorityRecord(declarations) ||
            declarations[name] !== entry["specifier"] ||
            !/^workspace:(?:\*|\^|~)$/.test(entry["specifier"] as string)
          )
            inputFailure("unsupported-lock-acquisition");
        } else if (!registryVersion(version))
          inputFailure("unsupported-lock-acquisition");
      }
    }
  }
  for (const catalog of Object.values(
    (lock["catalogs"] ?? {}) as Record<string, unknown>
  )) {
    if (!authorityRecord(catalog)) inputFailure("unsupported-lock-acquisition");
    for (const [name, entry] of Object.entries(catalog)) {
      if (
        !(packageName.test(name) && authorityRecord(entry)) ||
        Object.keys(entry).some(
          (key) => !["specifier", "version"].includes(key)
        ) ||
        !dependencySpecifier(entry["specifier"]) ||
        !registryVersion(entry["version"])
      )
        inputFailure("unsupported-lock-acquisition");
    }
  }
  for (const [name, pkg] of Object.entries(
    (lock["packages"] ?? {}) as Record<string, unknown>
  )) {
    if (
      !(
        registryVersion(name) &&
        authorityRecord(pkg) &&
        authorityRecord(pkg["resolution"])
      ) ||
      Object.keys(pkg).some(
        (key) =>
          ![
            "resolution",
            "peerDependencies",
            "engines",
            "hasBin",
            "peerDependenciesMeta",
            "cpu",
            "os",
            "libc",
            "deprecated",
            "bundledDependencies",
          ].includes(key)
      )
    )
      inputFailure("unsupported-lock-acquisition");
    const resolution = pkg["resolution"];
    if (
      Object.keys(resolution).length !== 1 ||
      typeof resolution["integrity"] !== "string" ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(resolution["integrity"])
    )
      inputFailure("unsupported-lock-acquisition");
    if (pkg["peerDependencies"] !== undefined)
      specifiers(pkg["peerDependencies"], "unsupported-lock-acquisition");
  }
  for (const [name, snapshot] of Object.entries(
    (lock["snapshots"] ?? {}) as Record<string, unknown>
  )) {
    if (
      !(registryVersion(name) && authorityRecord(snapshot)) ||
      Object.keys(snapshot).some(
        (key) =>
          ![
            "dependencies",
            "transitivePeerDependencies",
            "optionalDependencies",
            "optional",
          ].includes(key)
      )
    )
      inputFailure("unsupported-lock-acquisition");
    for (const group of ["dependencies", "optionalDependencies"]) {
      if (
        snapshot[group] !== undefined &&
        (!authorityRecord(snapshot[group]) ||
          Object.entries(snapshot[group]).some(
            ([dependency, version]) =>
              !(packageName.test(dependency) && registryVersion(version))
          ))
      )
        inputFailure("unsupported-lock-acquisition");
    }
  }
};

export const materializeApprovedSource = async (
  request: ApprovedRevisionDeploymentRequest,
  reader: GitObjectReader,
  environment: DeploymentEnvironment
): Promise<ApprovedSource> => {
  validateRequest(request);
  assertAmbientInputs(environment);
  const verified = async (
    kind: "commit" | "tree" | "blob",
    oid: string
  ): Promise<Buffer> => {
    if (!/^[a-f0-9]{40}$/.test(oid)) inputFailure("object-identity");
    const bytes = await reader.read(kind, oid);
    const limit = kind === "blob" ? inputLimits.blob : inputLimits.tree;
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length > limit ||
      objectId(kind, bytes) !== oid
    )
      inputFailure("object-integrity");
    return Buffer.from(bytes);
  };
  const commit = await verified("commit", request.exactSha);
  const tree = /^tree ([a-f0-9]{40})\n/.exec(commit.toString("utf8"))?.[1];
  if (!tree) inputFailure("commit-tree");
  const files: SourceFile[] = [];
  const paths = new Set<string>();
  let total = 0;
  const visit = async (
    oid: string,
    prefix: string,
    depth: number
  ): Promise<void> => {
    if (depth > inputLimits.depth) inputFailure("tree-depth");
    const bytes = await verified("tree", oid);
    let offset = 0;
    while (offset < bytes.length) {
      const space = bytes.indexOf(32, offset);
      const nul = bytes.indexOf(0, space + 1);
      if (space < offset || nul < space || nul + 21 > bytes.length)
        inputFailure("tree-format");
      const mode = bytes.subarray(offset, space).toString("ascii");
      const nameBytes = bytes.subarray(space + 1, nul);
      const name = nameBytes.toString("utf8");
      if (!Buffer.from(name).equals(nameBytes) || name.includes("/"))
        inputFailure("tree-name");
      const path = prefix + name;
      assertSourcePath(path);
      const key = path.toLowerCase();
      if (paths.has(key) || paths.size >= inputLimits.files)
        inputFailure("tree-collision-or-count");
      paths.add(key);
      const child = bytes.subarray(nul + 1, nul + 21).toString("hex");
      offset = nul + 21;
      if (mode === "40000") {
        await visit(child, `${path}/`, depth + 1);
      } else {
        if (mode !== "100644" && mode !== "100755")
          inputFailure("source-link-or-mode");
        const content = await verified("blob", child);
        total += content.length;
        if (total > inputLimits.total) inputFailure("source-size");
        files.push(
          Object.freeze({
            path,
            mode,
            oid: child,
            sha256: sha256(content),
            bytes: content,
          })
        );
      }
    }
  };
  await visit(tree, "", 0);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const configuration = files.find(
    (file) => file.path === "apps/web/wrangler.jsonc"
  );
  if (!configuration) inputFailure("missing-configuration");
  revalidateDestination(request, configuration.bytes, environment);
  const manifest = files.map(({ path, mode, oid, sha256: digest }) => ({
    path,
    mode,
    oid,
    sha256: digest,
  }));
  const authority = manifest.filter(
    (file) =>
      /(?:^|\/)package\.json$/.test(file.path) ||
      [
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        ".nvmrc",
        "infra/docker/deployment/policy.json",
      ].includes(file.path) ||
      file.path.startsWith("patches/")
  );
  for (const path of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".nvmrc",
    "infra/docker/deployment/policy.json",
  ]) {
    if (!authority.some((file) => file.path === path))
      inputFailure("dependency-authority");
  }
  validateDependencyAuthority(files);
  return Object.freeze({
    exactSha: request.exactSha,
    tree,
    manifestSha256: sha256(JSON.stringify(manifest)),
    dependencyAuthoritySha256: sha256(JSON.stringify(authority)),
    files: Object.freeze(files),
  });
};
