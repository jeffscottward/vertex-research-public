import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeApprovedSource } from "./approved-inputs.ts";
import {
  capsuleDigest,
  createDockerRunnerPorts,
  executableFromTar,
  executeBoundedCommand,
  isolatedContainerArguments,
  outputMounts,
  readOfflineCapsule,
  regularFileTar,
  type BoundedCommand,
  type BoundedCommandResult,
  type CapsuleFile,
} from "./runner-runtime.ts";
import { preparationPolicy } from "./runner.ts";
import {
  syntheticEnvironment,
  syntheticPolicy,
  syntheticRevision,
} from "./test-fixtures.ts";
import { runOfflineInputsFingerprint } from "./offline-inputs.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
// Mode bits that lstat reports in addition to the real ones, by absolute path.
const extraModeBits = vi.hoisted(() => new Map<string, number>());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (path: string, options?: { bigint?: false }) => {
      const stat = await actual.lstat(path, options);
      const bits = extraModeBits.get(path);
      if (bits !== undefined)
        Object.defineProperty(stat, "mode", { value: stat.mode | bits });
      return stat;
    },
  };
});
// A sandbox can refuse setuid/setgid bits (systemd RestrictSUIDSGID on the rig
// CI runner returns EPERM). Then lstat reports the setuid bit for this file, so
// the capsule reader still sees a special-mode file and must reject it.
const setSpecialMode = async (file: string): Promise<void> => {
  try {
    await chmod(file, 0o4644);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    extraModeBits.set(file, 0o4000);
  }
};
const roots: string[] = [];
const capsuleFiles: readonly CapsuleFile[] = [
  {
    path: "pnpm/bin/pnpm.cjs",
    mode: 0o644,
    bytes: Buffer.from("synthetic-pnpm"),
  },
  {
    path: "store/v11/files/ab/synthetic",
    mode: 0o644,
    bytes: Buffer.from("synthetic-store"),
  },
];
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "vertex-runner-test-"));
  roots.push(root);
  const capsule = join(root, "private/deployment/offline-inputs");
  for (const file of capsuleFiles) {
    const path = join(capsule, file.path);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, file.bytes, { mode: file.mode });
  }
  return { root, capsule, digest: capsuleDigest(capsuleFiles) };
};

afterEach(async () => {
  vi.restoreAllMocks();
  extraModeBits.clear();
  vi.clearAllMocks();
  vi.useRealTimers();
  return await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const tarEntries = (archive: Buffer) => {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (archive[offset] !== 0) {
    const header = archive.subarray(offset, offset + 512);
    const text = (start: number, end: number) =>
      header.subarray(start, end).toString("ascii").split("\0")[0]!;
    const name = text(0, 100);
    const prefix = text(345, 500);
    const size = Number.parseInt(text(124, 136), 8);
    files.set(
      prefix ? `${prefix}/${name}` : name,
      archive.subarray(offset + 512, offset + 512 + size)
    );
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
};

const backendFixture = async () => {
  const filesystem = await setup();
  const fixture = syntheticRevision({
    "infra/docker/deployment/policy.json": JSON.stringify({
      ...syntheticPolicy,
      offlineInputsSha256: filesystem.digest,
    }),
  });
  const snapshot = await materializeApprovedSource(
    fixture.request,
    fixture.reader,
    syntheticEnvironment
  );
  const policy = preparationPolicy(snapshot);
  const image = `sha256:${"a".repeat(64)}`;
  const identity = {
    sourceSha256: snapshot.manifestSha256,
    authoritySha256: snapshot.dependencyAuthoritySha256,
    policySha256: policy.sha256,
    dependencySha256: "b".repeat(64),
    toolchainSha256: "c".repeat(64),
  };
  const owned = new Map<string, string>();
  let owner = "";
  let archive: Buffer | undefined;
  const command = vi.fn(
    async (request: BoundedCommand): Promise<BoundedCommandResult> => {
      const args = request.args.slice(2);
      const output = (value = "", code = 0) => ({
        code,
        output: Buffer.from(value),
      });
      if (request.executable === "/usr/bin/git") return output("object");
      if (args[0] === "cp") {
        if (args[1] === "--archive") {
          archive = request.input;
          return output();
        }
        return {
          code: 0,
          output: regularFileTar([
            { path: "bun", mode: 0o755, bytes: Buffer.from("synthetic-bun") },
          ]),
        };
      }
      if (args[0] === "commit") return output(image);
      if (args[0] === "image" && args[1] === "inspect") {
        if (args[3] === "{{.Os}}/{{.Architecture}} {{.Id}}")
          return output(
            "linux/amd64 sha256:" +
              (args[4]!.includes("library/node")
                ? "2df3087de7bd33a7579b648e8f0620a2074478d94dcc4efde3b33dcab34017d5"
                : "424b596babfe001677cb0b67f0c01c3effaa20c630300858713c28dbd852532c")
          );
        if (args[3]!.includes("Labels")) return output(`${image} ${owner}`);
        return output(image);
      }
      if (args[0] === "create") {
        owner = args[args.indexOf("--label") + 1]!.split("=")[1]!;
        const id = String(owned.size + 1).repeat(64);
        owned.set(args[args.indexOf("--name") + 1]!, id);
        return output(id);
      }
      if (args[0] === "start")
        return output(request.capture ? JSON.stringify(identity) : "");
      if (args[0] === "container" && args[1] === "inspect") {
        if (args[3]!.includes("State")) return output("exited 0 false");
        return output(`${owned.get(args[4]!)} ${owner}`);
      }
      if (
        (args[0] === "container" && args[1] === "rm") ||
        (args[0] === "image" && args[1] === "rm")
      )
        return output();
      throw new Error("unexpected command");
    }
  );
  const environment = {
    ...syntheticEnvironment,
    CLOUDFLARE_API_TOKEN: "SYNTHETIC_PROVIDER_TOKEN",
    PRIVATE_SENTINEL: "NEVER_FORWARD",
  };
  const ports = createDockerRunnerPorts(
    filesystem.root,
    environment,
    vi.fn(async () => undefined),
    command
  );
  return {
    ...filesystem,
    ...fixture,
    snapshot,
    policy,
    image,
    identity,
    ports,
    command,
    environment,
    archive: () => archive!,
  };
};

describe("offline immutable capsule and tar", () => {
  it("copies regular owned bytes, checks the whole capsule digest, and never uses host mounts", async () => {
    const fixture = await setup();
    const files = await readOfflineCapsule(fixture.capsule, fixture.digest);
    expect(capsuleDigest(files)).toBe(fixture.digest);
    await writeFile(join(fixture.capsule, capsuleFiles[0]!.path), "changed");
    expect(files[0]!.bytes.toString()).toBe("synthetic-pnpm");
    return await expect(
      readOfflineCapsule(fixture.capsule, fixture.digest)
    ).rejects.toThrow("offline-capsule-integrity");
  });

  it.each([
    "link",
    "hardlink",
    "directory-link",
    "special-mode",
    "layout",
    "missing-pnpm",
  ])("rejects capsule %s", async (kind) => {
    const fixture = await setup();
    const file = join(fixture.capsule, capsuleFiles[0]!.path);
    if (kind === "link") {
      await rm(file);
      await symlink("/foreign/input", file);
    }
    if (kind === "hardlink")
      await link(file, join(fixture.root, "foreign-link"));
    if (kind === "directory-link")
      await symlink(fixture.capsule, join(fixture.capsule, "store/alias"));
    if (kind === "special-mode") await setSpecialMode(file);
    if (kind === "layout")
      await writeFile(join(fixture.capsule, "secret"), "sentinel");
    if (kind === "missing-pnpm") await rm(file);
    const read = readOfflineCapsule(fixture.capsule, fixture.digest);
    // A real or simulated setuid bit must fail the file check, not another one.
    if (kind === "special-mode")
      return await expect(read).rejects.toThrow("offline-capsule-file");
    return await expect(read).rejects.toThrow();
  });

  it("rejects overlarge sparse capsule files before reading bytes", async () => {
    const fixture = await setup();
    await truncate(join(fixture.capsule, capsuleFiles[0]!.path), 134_217_729);
    return await expect(
      readOfflineCapsule(fixture.capsule, fixture.digest)
    ).rejects.toThrow("offline-capsule-file");
  });

  it("bounds recursive capsule traversal", async () => {
    const fixture = await setup();
    await mkdir(
      join(
        fixture.capsule,
        "store",
        ...Array.from({ length: 33 }, () => "deep")
      ),
      { recursive: true }
    );
    return await expect(
      readOfflineCapsule(fixture.capsule, fixture.digest)
    ).rejects.toThrow("offline-capsule-depth");
  });

  it("rejects missing and symlinked capsule roots without traversing them", async () => {
    const fixture = await setup();
    await expect(
      readOfflineCapsule(`${fixture.root}/absent`, fixture.digest)
    ).rejects.toThrow();
    await symlink(fixture.capsule, join(fixture.root, "alias"));
    await expect(
      readOfflineCapsule(join(fixture.root, "alias"), fixture.digest)
    ).rejects.toThrow("offline-capsule-path");
    return await expect(
      readOfflineCapsule(fixture.capsule, "bad")
    ).rejects.toThrow("offline-capsule-path");
  });

  it("fingerprints capsule bytes without granting approval, editing policy or launching a process", async () => {
    const fixture = await setup();
    const output = { write: vi.fn() };
    const error = { write: vi.fn() };
    expect(
      await runOfflineInputsFingerprint(
        ["fingerprint"],
        fixture.root,
        output,
        error
      )
    ).toBe(0);
    expect(JSON.parse(output.write.mock.calls[0]![0])).toMatchObject({
      offlineInputsSha256: fixture.digest,
      files: 2,
      approval: false,
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(
      await runOfflineInputsFingerprint([], fixture.root, output, error)
    ).toBe(1);
    expect(
      await runOfflineInputsFingerprint(
        ["fingerprint", "--approve"],
        fixture.root,
        output,
        error
      )
    ).toBe(1);
    expect(
      await runOfflineInputsFingerprint(
        ["fingerprint"],
        `${fixture.root}/absent`,
        output,
        error
      )
    ).toBe(1);
    return expect(JSON.stringify(error.write.mock.calls)).not.toContain(
      fixture.root
    );
  });

  it("constructs only deterministic regular ustar records, including bounded prefixes", () => {
    const name = `prefix/${"long/".repeat(20)}entry`;
    const files = [
      ...capsuleFiles,
      { path: name, mode: 0o755, bytes: Buffer.from("payload") },
    ];
    const tar = regularFileTar(files);
    expect(tar.equals(regularFileTar(files))).toBe(true);
    expect(tar.length % 512).toBe(0);
    expect([...tarEntries(tar).keys()]).toEqual(files.map((file) => file.path));
    expect(tarEntries(tar).get(name)?.toString()).toBe("payload");
    expect(tar.subarray(-1024).equals(Buffer.alloc(1024))).toBe(true);
    expect(() => regularFileTar([capsuleFiles[0]!, capsuleFiles[0]!])).toThrow(
      "archive-entry"
    );
    expect(() =>
      regularFileTar([{ ...capsuleFiles[0]!, mode: 0o600 }])
    ).toThrow("archive-entry");
    expect(() =>
      regularFileTar([{ ...capsuleFiles[0]!, path: "x".repeat(101) }])
    ).toThrow("archive-name");
    return expect(() =>
      regularFileTar([{ ...capsuleFiles[0]!, path: "../outside" }])
    ).toThrow("unsafe-path");
  });

  return it("accepts only a checksummed single regular executable archive from the pinned image", () => {
    const archive = regularFileTar([
      { path: "bun", mode: 0o755, bytes: Buffer.from("binary") },
    ]);
    expect(executableFromTar(archive).toString()).toBe("binary");
    for (const invalid of [
      Buffer.alloc(0),
      archive.subarray(0, 1024),
      regularFileTar([
        { path: "other", mode: 0o755, bytes: Buffer.from("binary") },
      ]),
      regularFileTar([
        { path: "bun", mode: 0o755, bytes: Buffer.from("binary") },
        { path: "other", mode: 0o644, bytes: Buffer.from("extra") },
      ]),
    ]) {
      expect(() => executableFromTar(invalid)).toThrow("toolchain-archive");
    }
    const corrupt = Buffer.from(archive);
    corrupt[156] = 50;
    return expect(() => executableFromTar(corrupt)).toThrow(
      "toolchain-archive"
    );
  });
});

describe("concrete isolated backend", () => {
  it("is inert on construction and cleans no unrelated resources", async () => {
    const command = vi.fn();
    const ports = createDockerRunnerPorts(
      "/synthetic",
      {},
      async () => undefined,
      command
    );
    expect(command).not.toHaveBeenCalled();
    await ports.cleanup();
    return expect(command).not.toHaveBeenCalled();
  });

  it("uses no-replacement exact Git reads and a controlled process environment", async () => {
    const command = vi.fn(
      async (_request: BoundedCommand): Promise<BoundedCommandResult> => ({
        code: 0,
        output: Buffer.from("object"),
      })
    );
    const ports = createDockerRunnerPorts(
      "/synthetic",
      { NODE_OPTIONS: "NEVER_FORWARD" },
      async () => undefined,
      command
    );
    await ports.reader.read("tree", "a".repeat(40));
    expect(command.mock.calls[0]![0].environment).toMatchObject({
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
    });
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "/usr/bin/git",
        args: ["--no-replace-objects", "cat-file", "tree", "a".repeat(40)],
        capture: true,
      })
    );
    expect(JSON.stringify(command.mock.calls)).not.toContain("NEVER_FORWARD");
    await expect(ports.reader.read("tree", "HEAD")).rejects.toThrow(
      "git-object"
    );
    command.mockResolvedValue({ code: 1, output: Buffer.alloc(0) });
    return await expect(
      ports.reader.read("tree", "a".repeat(40))
    ).rejects.toThrow("git-object");
  });

  it.each(["check", "deploy"] as const)(
    "prepares and executes %s with fixed isolated inputs and scoped cleanup",
    async (mode) => {
      const fixture = await backendFixture();
      const inputs = await fixture.ports.prepare(
        fixture.snapshot,
        fixture.policy.policy,
        fixture.policy.sha256
      );
      expect(inputs).toEqual({ imageId: fixture.image, ...fixture.identity });
      const archived = tarEntries(fixture.archive());
      expect(
        archived.get("workspace/apps/web/wrangler.jsonc")?.toString()
      ).toBe(fixture.files["apps/web/wrangler.jsonc"]);
      expect(archived.get("opt/vertex/prepare.sh")?.toString()).toContain(
        "--offline --frozen-lockfile --ignore-scripts --package-import-method=copy"
      );
      expect(archived.get("opt/vertex/prepare.sh")?.toString()).toContain(
        "rebuild esbuild sharp workerd"
      );
      fixture.environment.CLOUDFLARE_API_TOKEN = "CHANGED_TOKEN";
      expect(
        await fixture.ports.execute(inputs, { mode, environment: "staging" })
      ).toBe(0);
      await fixture.ports.cleanup();
      const commands = fixture.command.mock.calls.map(([command]) => command);
      expect(
        commands.some((command) => command.args.includes("--network=none"))
      ).toBe(true);
      expect(
        commands
          .filter((command) => command.args[2] === "create")
          .every((command) => command.args.includes("--pull=never"))
      ).toBe(true);
      expect(
        commands.some(
          (command) =>
            command.args.includes("build") || command.args.includes("pull")
        )
      ).toBe(false);
      expect(
        commands.every(
          (command) =>
            !command.args.some(
              (arg) => arg === "--mount" || arg === "--volume" || arg === "-v"
            )
        )
      ).toBe(true);
      expect(
        JSON.stringify(commands.map((command) => command.args))
      ).not.toContain("SYNTHETIC_PROVIDER_TOKEN");
      const credentialCommands = commands.filter(
        (command) => command.environment["CLOUDFLARE_API_TOKEN"] !== undefined
      );
      expect(credentialCommands).toHaveLength(mode === "deploy" ? 1 : 0);
      if (mode === "deploy")
        expect(credentialCommands[0]!.environment["CLOUDFLARE_API_TOKEN"]).toBe(
          "SYNTHETIC_PROVIDER_TOKEN"
        );
      expect(
        commands.every(
          (command) => command.environment["PRIVATE_SENTINEL"] === undefined
        )
      ).toBe(true);
      expect(
        commands.some((command) => command.args.includes("--log-driver=none"))
      ).toBe(true);
      expect(
        commands.filter((command) => command.args.includes("rm"))
      ).toHaveLength(5);
      expect(commands.some((command) => command.args.includes("prune"))).toBe(
        false
      );
      return expect(
        await readFile(join(fixture.capsule, capsuleFiles[0]!.path), "utf8")
      ).toBe("synthetic-pnpm");
    }
  );

  it.each(["image", "cp", "commit", "create", "start"])(
    "propagates %s preparation failure without host fallback",
    async (step) => {
      const fixture = await backendFixture();
      const original = fixture.command.getMockImplementation()!;
      fixture.command.mockImplementation(async (command) =>
        command.args[2] === step
          ? { code: 9, output: Buffer.from("PRIVATE_ERROR") }
          : original(command)
      );
      await expect(
        fixture.ports.prepare(
          fixture.snapshot,
          fixture.policy.policy,
          fixture.policy.sha256
        )
      ).rejects.toThrow();
      try {
        await fixture.ports.cleanup();
      } catch {
        // Failed create may leave uncertainty, never deletion of a foreign target.
      }
      return expect(
        fixture.command.mock.calls.every(
          ([command]) => command.executable === "/usr/bin/docker"
        )
      ).toBe(true);
    }
  );

  it("does not accept arbitrary image identities or remove foreign-labeled resources", async () => {
    const fixture = await backendFixture();
    const inputs = await fixture.ports.prepare(
      fixture.snapshot,
      fixture.policy.policy,
      fixture.policy.sha256
    );
    await expect(
      fixture.ports.execute(
        { ...inputs, imageId: `sha256:${"d".repeat(64)}` },
        { mode: "check", environment: "production" }
      )
    ).rejects.toThrow("unowned-image");
    const original = fixture.command.getMockImplementation()!;
    fixture.command.mockImplementation(async (command) =>
      command.args.some((arg) => arg.includes("Labels"))
        ? { code: 0, output: Buffer.from(`${"f".repeat(64)} foreign-owner`) }
        : original(command)
    );
    await expect(fixture.ports.cleanup()).rejects.toThrow("cleanup");
    return expect(
      fixture.command.mock.calls.some(([command]) =>
        command.args.includes("rm")
      )
    ).toBe(false);
  });

  it("rejects platform drift and forged image reports", async () => {
    for (const failure of ["platform", "report", "state"]) {
      const fixture = await backendFixture();
      const original = fixture.command.getMockImplementation()!;
      fixture.command.mockImplementation(async (command) => {
        if (
          failure === "platform" &&
          command.args.some((arg) => arg.includes(".Architecture"))
        )
          return {
            code: 0,
            output: Buffer.from(`linux/arm64 ${fixture.image}`),
          };
        if (failure === "report" && command.args[2] === "start")
          return { code: 0, output: Buffer.from('{"secret":"sentinel"}') };
        if (
          failure === "state" &&
          command.args.some((arg) => arg.includes(".State"))
        )
          return { code: 0, output: Buffer.from("running 0 false") };
        return original(command);
      });
      await expect(
        fixture.ports.prepare(
          fixture.snapshot,
          fixture.policy.policy,
          fixture.policy.sha256
        )
      ).rejects.toThrow();
      await fixture.ports.cleanup();
    }
  });

  return it("constructs a non-root read-only namespace with only explicit disposable outputs", () => {
    const args = isolatedContainerArguments(
      `sha256:${"a".repeat(64)}`,
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    );
    expect(args).toContain("--network=none");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--user=65532:65532");
    expect(args).toContain("--entrypoint=/usr/local/bin/node");
    expect(args).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(outputMounts).not.toContain("/workspace");
    expect(outputMounts).not.toContain("/workspace/node_modules");
    return expect(() =>
      isolatedContainerArguments("mutable:tag", "owner")
    ).toThrow("container-identity");
  });
});

describe("bounded subprocess streams", () => {
  const command: BoundedCommand = {
    executable: "/usr/bin/docker",
    args: ["synthetic"],
    cwd: "/",
    environment: {},
    capture: false,
    maxOutput: 16,
    timeout: 100,
  };
  const childFixture = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    });
    vi.mocked(spawn).mockReturnValue(
      child as unknown as ReturnType<typeof spawn>
    );
    return child;
  };

  it("discards provider stdout/stderr and closes stdin with shell disabled", async () => {
    const child = childFixture();
    const result = executeBoundedCommand(command);
    child.stdout.emit("data", Buffer.from("sentinel"));
    child.stderr.emit("data", Buffer.from("secret"));
    child.emit("close", 0, null);
    expect(await result).toEqual({ code: 0, output: Buffer.alloc(0) });
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/docker",
      ["synthetic"],
      expect.objectContaining({
        shell: false,
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
      })
    );
    return expect(child.stdin.writableEnded).toBe(true);
  });

  it("captures only bounded stdout for allowlisted metadata", async () => {
    const child = childFixture();
    const result = executeBoundedCommand({ ...command, capture: true });
    child.stdout.emit("data", Buffer.from("digest"));
    child.stderr.emit("data", Buffer.from("discard"));
    child.emit("close", 7, null);
    return expect(await result).toEqual({
      code: 7,
      output: Buffer.from("digest"),
    });
  });

  it.each(["overflow", "signal", "error", "stdin"])(
    "terminates/rejects %s without publishing arbitrary output",
    async (failure) => {
      const child = childFixture();
      const result = executeBoundedCommand(command);
      const rejection = expect(result).rejects.toThrow("deployment-process");
      if (failure === "overflow") child.stdout.emit("data", Buffer.alloc(17));
      if (failure === "stdin") child.stdin.emit("error", new Error("sentinel"));
      if (failure === "error") {
        child.emit("error", new Error("sentinel"));
        child.emit("close", 1, null);
      }
      if (failure === "signal") child.emit("close", null, "SIGTERM");
      return await rejection;
    }
  );

  it("times out and waits for child termination rather than retrying", async () => {
    vi.useFakeTimers();
    const child = childFixture();
    const result = executeBoundedCommand(command);
    const rejection = expect(result).rejects.toThrow("deployment-process");
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    return expect(spawn).toHaveBeenCalledOnce();
  });

  return it("sanitizes synchronous spawn failures", async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error("PRIVATE_SENTINEL");
    });
    return await expect(executeBoundedCommand(command)).rejects.toThrow(
      "deployment-process:spawn"
    );
  });
});
