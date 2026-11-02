import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertInputPath,
  inputFailure,
  inputLimits,
  sha256,
  type ApprovedRevisionDeploymentRequest,
  type ApprovedSource,
} from "./approved-inputs.ts";
import type { DeploymentEnvironment } from "./database.ts";
import {
  deploymentPreparationScript,
  deploymentGuard,
} from "./runner-program.ts";
import {
  officialAdapterArguments,
  type AdapterOperation,
  type DeploymentRunnerPorts,
  type PreparationPolicy,
  type SealedDeploymentInputs,
} from "./runner.ts";

export type BoundedCommand = Readonly<{
  executable: "/usr/bin/git" | "/usr/bin/docker";
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  input?: Buffer;
  capture: boolean;
  maxOutput: number;
  timeout: number;
}>;
export type BoundedCommandResult = Readonly<{ code: number; output: Buffer }>;
export type CommandPort = (
  command: BoundedCommand
) => Promise<BoundedCommandResult>;

export const executeBoundedCommand: CommandPort = (command) =>
  new Promise((resolveResult, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.executable, [...command.args], {
        cwd: command.cwd,
        env: { ...command.environment },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
    } catch {
      reject(new Error("deployment-process:spawn"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const stop = () => {
      failed = true;
      return child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, command.timeout);
    const observe = (chunk: Buffer, stdout: boolean) => {
      size += chunk.length;
      if (size > command.maxOutput) {
        return stop();
      }
      if (stdout && command.capture) {
        return chunks.push(Buffer.from(chunk));
      }
      return;
    };
    child.stdout?.on("data", (chunk: Buffer) => observe(chunk, true));
    child.stderr?.on("data", (chunk: Buffer) => observe(chunk, false));
    child.stdin?.on("error", stop);
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failed || signal || code === null) {
        return reject(new Error("deployment-process:failed-or-bounded"));
      }
      return resolveResult(
        Object.freeze({
          code,
          output: command.capture ? Buffer.concat(chunks) : Buffer.alloc(0),
        })
      );
    });
    return child.stdin?.end(command.input);
  });

export type CapsuleFile = Readonly<{
  path: string;
  mode: number;
  bytes: Buffer;
  uid?: number;
  directory?: boolean;
}>;
const capsuleLimits = Object.freeze({
  files: 100_000,
  bytes: 1_073_741_824,
  file: 134_217_728,
});
export const capsuleDigest = (files: readonly CapsuleFile[]): string =>
  sha256(
    JSON.stringify(
      files.map((file) => [file.path, file.mode, sha256(file.bytes)])
    )
  );

// Omitting expected is used only by the credentialless fingerprint command.
// Deployment always passes the exact digest from its approved Git policy.
export const readOfflineCapsule = async (
  root: string,
  expected?: string
): Promise<readonly CapsuleFile[]> => {
  if (
    (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) ||
    (await realpath(root)) !== root ||
    !(await lstat(root)).isDirectory()
  )
    inputFailure("offline-capsule-path");
  const files: CapsuleFile[] = [];
  let size = 0;
  let entries = 0;
  const visit = async (
    directory: string,
    prefix: string,
    depth: number
  ): Promise<void> => {
    if (depth > 32) inputFailure("offline-capsule-depth");
    for (const name of (await readdir(directory)).sort()) {
      entries += 1;
      if (entries > 200_000) inputFailure("offline-capsule-count");
      const path = prefix + name;
      assertInputPath(path);
      if (
        !(
          path === "pnpm" ||
          path === "store" ||
          path.startsWith("pnpm/") ||
          path.startsWith("store/")
        )
      )
        inputFailure("offline-capsule-layout");
      const absolute = join(directory, name);
      const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        if ((await realpath(absolute)) !== absolute)
          inputFailure("offline-capsule-link");
        await visit(absolute, `${path}/`, depth + 1);
      } else {
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size > capsuleLimits.file ||
          (stat.mode & 0o6000) !== 0 ||
          files.length >= capsuleLimits.files
        )
          inputFailure("offline-capsule-file");
        const fd = await open(
          absolute,
          constants.O_RDONLY | constants.O_NOFOLLOW
        );
        try {
          const before = await fd.stat();
          if (
            before.ino !== stat.ino ||
            before.dev !== stat.dev ||
            before.nlink !== 1 ||
            before.size !== stat.size
          )
            inputFailure("offline-capsule-drift");
          const bytes = Buffer.alloc(stat.size);
          let offset = 0;
          while (offset < bytes.length) {
            const result = await fd.read(
              bytes,
              offset,
              bytes.length - offset,
              offset
            );
            if (result.bytesRead === 0) inputFailure("offline-capsule-drift");
            offset += result.bytesRead;
          }
          const after = await fd.stat();
          if (
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs ||
            after.nlink !== 1
          )
            inputFailure("offline-capsule-drift");
          size += bytes.length;
          if (size > capsuleLimits.bytes) inputFailure("offline-capsule-size");
          files.push(
            Object.freeze({
              path,
              mode: stat.mode & 0o111 ? 0o755 : 0o644,
              bytes,
            })
          );
        } finally {
          await fd.close();
        }
      }
    }
  };
  await visit(root, "", 0);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (
    !(
      files.some((file) => file.path === "pnpm/bin/pnpm.cjs") &&
      files.some((file) => file.path.startsWith("store/"))
    ) ||
    (expected !== undefined && capsuleDigest(files) !== expected)
  )
    inputFailure("offline-capsule-integrity");
  return Object.freeze(files);
};

// No archive extractor runs on host input. Construct bounded regular-file and
// directory ustar records only, with centrally assigned ownership and modes.
export const regularFileTar = (files: readonly CapsuleFile[]): Buffer => {
  const chunks: Buffer[] = [];
  const seen = new Set<string>();
  let total = 1024;
  for (const file of files) {
    assertInputPath(file.path);
    if (
      seen.has(file.path) ||
      ![0o644, 0o755].includes(file.mode) ||
      ![0, 65_532].includes(file.uid ?? 0) ||
      (file.directory && (file.bytes.length !== 0 || file.mode !== 0o755))
    )
      inputFailure("archive-entry");
    seen.add(file.path);
    const slash = file.path.lastIndexOf("/");
    const prefix = file.path.length > 100 ? file.path.slice(0, slash) : "";
    const name =
      file.path.length > 100 ? file.path.slice(slash + 1) : file.path;
    if (name.length > 100 || prefix.length > 155 || !name)
      inputFailure("archive-name");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "ascii");
    const octal = (value: number, offset: number, length: number) =>
      header.write(
        `${value.toString(8).padStart(length - 1, "0")}\0`,
        offset,
        length,
        "ascii"
      );
    octal(file.mode, 100, 8);
    octal(file.uid ?? 0, 108, 8);
    octal(file.uid ?? 0, 116, 8);
    octal(file.bytes.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = file.directory ? 53 : 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.write(prefix, 345, 155, "ascii");
    header.write(
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0")}\0 `,
      148,
      8,
      "ascii"
    );
    const padding = Buffer.alloc((512 - (file.bytes.length % 512)) % 512);
    total += 512 + file.bytes.length + padding.length;
    if (total > capsuleLimits.bytes + inputLimits.total + 134_217_728)
      inputFailure("archive-size");
    chunks.push(header, file.bytes, padding);
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
};

// Docker copies a single executable from the pinned Bun image. Accept no
// archive links, extra files, traversal, sparse/base-256 encoding or extraction.
export const executableFromTar = (archive: Buffer): Buffer => {
  if (
    archive.length < 1536 ||
    archive.length > capsuleLimits.file + 4096 ||
    archive.length % 512 !== 0
  )
    inputFailure("toolchain-archive");
  const header = archive.subarray(0, 512);
  const headerField = (from: number, to: number) =>
    header.subarray(from, to).toString("ascii").replace(/\0.*$/, "").trim();
  const rawSize = headerField(124, 136);
  const checksum = headerField(148, 156);
  const size = Number.parseInt(rawSize, 8);
  const sum = header.reduce(
    (total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte),
    0
  );
  if (
    !(/^[0-7]+$/.test(rawSize) && /^[0-7]+$/.test(checksum)) ||
    Number.parseInt(checksum, 8) !== sum ||
    headerField(0, 100) !== "bun" ||
    headerField(345, 500) !== "" ||
    ![0, 48].includes(header.readUInt8(156)) ||
    size < 1 ||
    size > capsuleLimits.file
  )
    inputFailure("toolchain-archive");
  const end = 512 + Math.ceil(size / 512) * 512;
  if (
    end + 1024 > archive.length ||
    archive.subarray(end).some((byte) => byte !== 0)
  )
    inputFailure("toolchain-archive");
  return Buffer.from(archive.subarray(512, 512 + size));
};

const runtimeConfigIds = Object.freeze([
  "sha256:2df3087de7bd33a7579b648e8f0620a2074478d94dcc4efde3b33dcab34017d5",
  "sha256:424b596babfe001677cb0b67f0c01c3effaa20c630300858713c28dbd852532c",
]);

const fixedEnvironment = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/nonexistent",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_ALLOW_PROTOCOL: "",
  GIT_TERMINAL_PROMPT: "0",
});
const label = "org.vertex.deployment.run";
const imageId = /^sha256:[a-f0-9]{64}$/;
const containerId = /^[a-f0-9]{64}$/;
export const outputMounts = Object.freeze([
  "/workspace/apps/web/dist",
  "/workspace/apps/web/.wrangler",
  "/workspace/apps/web/node_modules/.vite-temp",
  "/workspace/apps/web/node_modules/.vite",
  "/workspace/node_modules/.vite-temp",
]);

export const isolatedContainerArguments = (
  image: string,
  owner: string,
  operation?: AdapterOperation
): readonly string[] => {
  if (!(imageId.test(image) && /^[a-f0-9-]{36}$/.test(owner)))
    inputFailure("container-identity");
  if (operation) officialAdapterArguments(operation);
  return [
    "create",
    "--label",
    `${label}=${owner}`,
    "--pull=never",
    "--platform=linux/amd64",
    "--read-only",
    "--user=65532:65532",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    "--memory=8g",
    "--cpus=4",
    "--ulimit",
    "nofile=4096:4096",
    "--ipc=none",
    "--log-driver=none",
    `--network=${operation?.mode === "deploy" ? "bridge" : "none"}`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777",
    ...outputMounts.flatMap((path) => [
      "--tmpfs",
      `${path}:rw,nosuid,nodev,noexec,size=1g,uid=65532,gid=65532,mode=0700`,
    ]),
    "--workdir=/workspace/apps/web",
    "--entrypoint=/usr/local/bin/node",
    ...(operation?.mode === "deploy" ? ["--env", "CLOUDFLARE_API_TOKEN"] : []),
    image,
    "/opt/vertex/guard.mjs",
    ...(operation
      ? ["run", operation.mode, operation.environment]
      : ["verify"]),
  ];
};

export const createDockerRunnerPorts = (
  root: string,
  source: DeploymentEnvironment,
  admit: (request: ApprovedRevisionDeploymentRequest) => Promise<void>,
  command: CommandPort = executeBoundedCommand
): DeploymentRunnerPorts => {
  const owner = randomUUID();
  const tag = `vertex-deployment-owned:${owner}`;
  const environment = Object.freeze({ ...source });
  const containers = new Map<string, string | undefined>();
  let builtImage: string | undefined;
  let attemptedBuild = false;
  let completedBuild = false;
  const docker = async (
    args: readonly string[],
    options: Readonly<{
      input?: Buffer;
      capture?: boolean;
      timeout?: number;
      credential?: string;
      archive?: boolean;
    }> = {}
  ): Promise<BoundedCommandResult> =>
    command({
      executable: "/usr/bin/docker",
      args: [
        "--host=unix:///var/run/docker.sock",
        "--config=/nonexistent",
        ...args,
      ],
      cwd: "/",
      environment: {
        PATH: "/usr/bin:/bin",
        HOME: "/nonexistent",
        LANG: "C",
        ...(options.credential
          ? { CLOUDFLARE_API_TOKEN: options.credential }
          : {}),
      },
      ...(options.input === undefined ? {} : { input: options.input }),
      capture: options.capture ?? false,
      maxOutput: options.archive
        ? capsuleLimits.file + 4096
        : options.capture
          ? 65_536
          : 16_777_216,
      timeout: options.timeout ?? 60_000,
    });
  const required = async (
    args: readonly string[],
    options: Parameters<typeof docker>[1] = {}
  ): Promise<Buffer> => {
    const result = await docker(args, options);
    if (result.code !== 0) inputFailure("container-operation");
    return result.output;
  };
  const createOwned = async (
    args: readonly string[],
    credential?: string
  ): Promise<string> => {
    const name = `vertex-deployment-${owner}-${containers.size}`;
    containers.set(name, undefined);
    const id = (
      await required([...args.slice(0, 1), "--name", name, ...args.slice(1)], {
        capture: true,
        ...(credential === undefined ? {} : { credential }),
      })
    )
      .toString("utf8")
      .trim();
    if (!containerId.test(id)) inputFailure("container-id");
    containers.set(name, id);
    return id;
  };
  const ownedContainer = async (
    inputs: string,
    operation?: AdapterOperation
  ): Promise<string> => {
    const credential =
      operation?.mode === "deploy"
        ? environment["CLOUDFLARE_API_TOKEN"]
        : undefined;
    if (
      operation?.mode === "deploy" &&
      (!credential ||
        credential.length > 4096 ||
        /[\x00-\x20\x7f]/.test(credential))
    )
      inputFailure("projected-provider-credential-required");
    return await createOwned(
      isolatedContainerArguments(inputs, owner, operation),
      credential
    );
  };
  const preparationArguments = (image: string): readonly string[] => [
    "create",
    "--label",
    `${label}=${owner}`,
    "--pull=never",
    "--platform=linux/amd64",
    "--network=none",
    "--user=65532:65532",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    "--memory=8g",
    "--cpus=4",
    "--log-driver=none",
    "--env",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "--env",
    "HOME=/tmp/vertex-preparation/home",
    "--env",
    "XDG_CONFIG_HOME=/tmp/vertex-preparation/config",
    "--env",
    "XDG_CACHE_HOME=/tmp/vertex-preparation/cache",
    "--env",
    "CI=true",
    "--env",
    "HUSKY=0",
    "--workdir=/workspace",
    "--entrypoint=/bin/sh",
    image,
    "/opt/vertex/prepare.sh",
  ];
  return {
    reader: {
      read: async (kind, oid) => {
        if (!/^[a-f0-9]{40}$/.test(oid)) inputFailure("git-object");
        const result = await command({
          executable: "/usr/bin/git",
          args: ["--no-replace-objects", "cat-file", kind, oid],
          cwd: root,
          environment: fixedEnvironment,
          capture: true,
          maxOutput: inputLimits.blob,
          timeout: 30_000,
        });
        if (result.code !== 0) inputFailure("git-object");
        return result.output;
      },
    },
    admit,
    prepare: async (
      snapshot: ApprovedSource,
      policy: PreparationPolicy,
      policySha256: string
    ): Promise<SealedDeploymentInputs> => {
      // Inspect exact pinned manifests and config IDs. Every subsequent create
      // uses a local content ID with --pull=never, including preparation.
      const baseIds: string[] = [];
      for (const [index, image] of [
        policy.nodeImage,
        policy.bunImage,
      ].entries()) {
        try {
          const metadata = (
            await required(
              [
                "image",
                "inspect",
                "--format",
                "{{.Os}}/{{.Architecture}} {{.Id}}",
                image,
              ],
              { capture: true }
            )
          )
            .toString("utf8")
            .trim();
          const expectedId =
            runtimeConfigIds[index] ?? inputFailure("runtime-image-platform");
          if (metadata !== `linux/amd64 ${expectedId}`)
            inputFailure("runtime-image-platform");
          baseIds.push(expectedId);
        } catch {
          inputFailure("runtime-image-unavailable");
        }
      }
      const [nodeBaseId, bunBaseId] = baseIds;
      if (nodeBaseId === undefined || bunBaseId === undefined)
        inputFailure("runtime-image-unavailable");
      let capsule: readonly CapsuleFile[];
      try {
        capsule = await readOfflineCapsule(
          resolve(root, "private/deployment/offline-inputs"),
          policy.offlineInputsSha256
        );
      } catch {
        inputFailure("offline-capsule-unavailable");
      }
      // This donor is never started and has no credential or host binding.
      const donor = await createOwned([
        "create",
        "--label",
        `${label}=${owner}`,
        "--pull=never",
        "--platform=linux/amd64",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--log-driver=none",
        "--entrypoint=/usr/local/bin/bun",
        bunBaseId,
        "--version",
      ]);
      const bun = executableFromTar(
        await required(["cp", `${donor}:/usr/local/bin/bun`, "-"], {
          capture: true,
          archive: true,
        })
      );
      const manifest = JSON.stringify({
        sourceSha256: snapshot.manifestSha256,
        authoritySha256: snapshot.dependencyAuthoritySha256,
        policySha256,
        files: snapshot.files.map(({ path, mode, sha256: digest }) => ({
          path,
          mode,
          sha256: digest,
        })),
      });
      const contents: CapsuleFile[] = [
        {
          path: "opt/vertex/prepare.sh",
          mode: 0o644,
          bytes: Buffer.from(deploymentPreparationScript),
        },
        {
          path: "opt/vertex/guard.mjs",
          mode: 0o644,
          bytes: Buffer.from(deploymentGuard),
        },
        {
          path: "opt/vertex/source-manifest.json",
          mode: 0o644,
          bytes: Buffer.from(manifest),
        },
        {
          path: "opt/vertex/inputs.json",
          mode: 0o644,
          uid: 65_532,
          bytes: Buffer.alloc(0),
        },
        { path: "usr/local/bin/bun", mode: 0o755, bytes: bun },
        ...snapshot.files.map((file) => ({
          path: `workspace/${file.path}`,
          mode: file.mode === "100755" ? 0o755 : 0o644,
          bytes: file.bytes,
        })),
        ...capsule.map((file) => ({
          ...file,
          uid: file.path.startsWith("pnpm/") ? 0 : 65_532,
          path: file.path.startsWith("pnpm/")
            ? `opt/${file.path}`
            : `opt/offline-store/${file.path.slice(6)}`,
        })),
      ];
      const parents = new Set<string>();
      for (const file of contents) {
        const segments = file.path.split("/");
        segments.pop();
        for (let count = 1; count <= segments.length; count += 1) {
          parents.add(segments.slice(0, count).join("/"));
        }
      }
      const directories = [...parents].sort().map((path) => ({
        path,
        mode: 0o755,
        directory: true,
        bytes: Buffer.alloc(0),
        uid:
          path === "workspace" ||
          path.startsWith("workspace/") ||
          path === "opt/offline-store" ||
          path.startsWith("opt/offline-store/")
            ? 65_532
            : 0,
      }));
      const archive = regularFileTar([...directories, ...contents]);
      const preparation = await createOwned(preparationArguments(nodeBaseId));
      await required(["cp", "--archive", "-", `${preparation}:/`], {
        input: archive,
        timeout: 300_000,
      });
      await required(["start", "--attach", preparation], {
        timeout: 1_800_000,
      });
      const preparedState = (
        await required(
          [
            "container",
            "inspect",
            "--format",
            "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}",
            preparation,
          ],
          { capture: true }
        )
      )
        .toString("utf8")
        .trim();
      if (preparedState !== "exited 0 false") inputFailure("preparation-state");
      attemptedBuild = true;
      await required(
        [
          "commit",
          "--pause=true",
          "--change",
          `LABEL ${label}=${owner}`,
          "--change",
          "USER 65532:65532",
          "--change",
          "WORKDIR /workspace/apps/web",
          "--change",
          "ENV PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp/home XDG_CONFIG_HOME=/tmp/config XDG_CACHE_HOME=/tmp/cache TMPDIR=/tmp CI=true NO_COLOR=1 WRANGLER_SEND_METRICS=false",
          preparation,
          tag,
        ],
        { timeout: 300_000 }
      );
      completedBuild = true;
      const id = (
        await required(["image", "inspect", "--format", "{{.Id}}", tag], {
          capture: true,
        })
      )
        .toString("utf8")
        .trim();
      if (!imageId.test(id)) inputFailure("sealed-image-id");
      builtImage = id;
      const check = await ownedContainer(id);
      const output = await required(["start", "--attach", check], {
        capture: true,
        timeout: 300_000,
      });
      const state = (
        await required(
          [
            "container",
            "inspect",
            "--format",
            "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}",
            check,
          ],
          { capture: true }
        )
      )
        .toString("utf8")
        .trim();
      if (state !== "exited 0 false") inputFailure("sealed-image-check");
      const identity: unknown = JSON.parse(output.toString("utf8"));
      if (
        typeof identity !== "object" ||
        identity === null ||
        Array.isArray(identity)
      )
        inputFailure("sealed-image-report");
      const record = identity as Record<string, unknown>;
      const keys = [
        "sourceSha256",
        "authoritySha256",
        "policySha256",
        "dependencySha256",
        "toolchainSha256",
      ];
      if (
        Object.keys(record).length !== keys.length ||
        keys.some(
          (key) =>
            typeof record[key] !== "string" ||
            !/^[a-f0-9]{64}$/.test(record[key] as string)
        )
      )
        inputFailure("sealed-image-report");
      return Object.freeze({
        imageId: id,
        ...record,
      }) as SealedDeploymentInputs;
    },
    execute: async (inputs, operation) => {
      if (inputs.imageId !== builtImage) inputFailure("unowned-image");
      const id = await ownedContainer(inputs.imageId, operation);
      const result = await docker(["start", "--attach", id], {
        timeout: 1_800_000,
      });
      if (result.code !== 0) return result.code;
      const state = (
        await required(
          [
            "container",
            "inspect",
            "--format",
            "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}",
            id,
          ],
          { capture: true }
        )
      )
        .toString("utf8")
        .trim();
      const match = /^exited ([0-9]{1,3}) false$/.exec(state);
      if (!match || Number(match[1]) > 255) inputFailure("execution-state");
      return Number(match[1]);
    },
    cleanup: async () => {
      let failed = false;
      for (const [name, knownId] of containers) {
        try {
          const identity = (
            await required(
              [
                "container",
                "inspect",
                "--format",
                `{{.Id}} {{index .Config.Labels "${label}"}}`,
                name,
              ],
              { capture: true }
            )
          )
            .toString("utf8")
            .trim()
            .split(" ");
          const id = identity[0] ?? "";
          if (
            !containerId.test(id) ||
            identity[1] !== owner ||
            (knownId && knownId !== id)
          )
            inputFailure("cleanup-ownership");
          await required(["container", "rm", "--force", id]);
          containers.delete(name);
        } catch {
          failed = true;
        }
      }
      if (attemptedBuild) {
        try {
          const found = await docker(
            [
              "image",
              "inspect",
              "--format",
              `{{.Id}} {{index .Config.Labels "${label}"}}`,
              tag,
            ],
            { capture: true }
          );
          if (found.code === 0) {
            const identity = found.output.toString("utf8").trim().split(" ");
            if (
              !imageId.test(identity[0] ?? "") ||
              identity[1] !== owner ||
              (builtImage && identity[0] !== builtImage)
            )
              inputFailure("cleanup-image-ownership");
            await required(["image", "rm", tag]);
          } else if (builtImage || !completedBuild) {
            failed = true;
          }
        } catch {
          failed = true;
        }
      }
      if (failed) return inputFailure("cleanup");
      return;
    },
  };
};
