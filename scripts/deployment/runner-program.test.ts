import crypto from "node:crypto";
import { constants } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  deploymentPreparationScript,
  deploymentGuard,
} from "./runner-program.ts";

interface VirtualEntry {
  kind: "file" | "directory" | "link" | "special";
  bytes: Buffer;
  mode: number;
  nlink: number;
  ino: number;
  uid: number;
  target?: string;
}
const guardFixture = () => {
  const entries = new Map<string, VirtualEntry>();
  let nextInode = 1;
  const descriptors = new Map<number, VirtualEntry>();
  let nextDescriptor = 1;
  const add = (
    name: string,
    text = "",
    kind: VirtualEntry["kind"] = "file",
    target?: string
  ) => {
    const parents = name.split("/");
    parents.pop();
    let parent = "";
    for (const segment of parents.filter(Boolean)) {
      parent += `/${segment}`;
      if (!entries.has(parent))
        entries.set(parent, {
          kind: "directory",
          bytes: Buffer.alloc(0),
          mode: 0o755,
          nlink: 1,
          ino: nextInode++,
          uid: 65_532,
        });
    }
    return entries.set(name, {
      kind,
      bytes: Buffer.from(text),
      mode: kind === "directory" ? 0o755 : 0o644,
      nlink: 1,
      ino: nextInode++,
      uid: name.includes("/node_modules/") ? 65_532 : 0,
      ...(target === undefined ? {} : { target }),
    });
  };
  const hash = (text: string) =>
    crypto.createHash("sha256").update(text).digest("hex");
  add("/workspace/package.json", "{}");
  add("/workspace/apps/web/package.json", "{}");
  add("/workspace/packages/shared/index.civet", "export const shared = true");
  for (const [name, version] of Object.entries({
    "@vinext/cloudflare": "1.0.0-beta.3",
    vinext: "1.0.0-beta.3",
    "@cloudflare/vite-plugin": "1.47.0",
    wrangler: "4.114.0",
    vite: "8.1.5",
  })) {
    add(
      `/workspace/apps/web/node_modules/${name}/package.json`,
      JSON.stringify({ version })
    );
  }
  add(
    "/workspace/node_modules/.pnpm/workerd@0/node_modules/workerd/bin/workerd",
    "native"
  );
  add(
    "/workspace/node_modules/.pnpm/sharp@0/node_modules/sharp/index.js",
    "native"
  );
  add(
    "/workspace/apps/web/node_modules/shared",
    "",
    "link",
    "../../../packages/shared"
  );
  for (const p of [
    "/usr/local/bin/node",
    "/usr/local/bin/bun",
    "/opt/vertex/guard.mjs",
  ])
    add(p, "tool");
  const files = [...entries]
    .filter(
      ([p, e]) =>
        p.startsWith("/workspace/") &&
        e.kind === "file" &&
        !p.includes("/node_modules/")
    )
    .map(([p, e]) => ({
      path: path.relative("/workspace", p),
      mode: "100644",
      sha256: hash(e.bytes.toString()),
    }));
  add(
    "/opt/vertex/source-manifest.json",
    JSON.stringify({
      files,
      sourceSha256: "a".repeat(64),
      authoritySha256: "b".repeat(64),
      policySha256: "c".repeat(64),
    })
  );
  const real = (p: string, visited = new Set<string>()): string => {
    if (visited.has(p)) throw new Error("loop");
    visited.add(p);
    const e = entries.get(p);
    if (!e) throw new Error("missing");
    if (e.kind === "link")
      return real(path.resolve(path.dirname(p), e.target!), visited);
    return p;
  };
  const stat = (e: VirtualEntry) => ({
    isDirectory: () => e.kind === "directory",
    isSymbolicLink: () => e.kind === "link",
    isFile: () => e.kind === "file",
    nlink: e.nlink,
    mode: e.mode,
    size: e.bytes.length,
    dev: 1,
    ino: e.ino,
    uid: e.uid,
    gid: e.uid,
    mtimeMs: 0,
    ctimeMs: 0,
  });
  const hardlink = (from: string, to: string) => {
    const original = entries.get(from)!;
    add(to);
    original.nlink += 1;
    return entries.set(to, original);
  };
  const fs = {
    constants,
    readdirSync: (p: string) =>
      [...entries.keys()]
        .filter((key) => path.dirname(key) === p)
        .map((key) => path.basename(key)),
    lstatSync: (p: string) => {
      const e = entries.get(p)!;
      if (!e) throw new Error("missing");
      return stat(e);
    },
    readFileSync: (p: string, encoding?: string) =>
      encoding
        ? entries.get(real(p))?.bytes.toString()
        : entries.get(real(p))?.bytes,
    readlinkSync: (p: string) => entries.get(p)?.target,
    realpathSync: (p: string) => real(p),
    writeFileSync: (p: string | number, text: string | Buffer) => {
      if (typeof p === "number") {
        return (descriptors.get(p)!.bytes = Buffer.from(text));
      }
      return add(p, text.toString());
    },
    mkdirSync: (p: string) => add(p, "", "directory"),
    openSync: (p: string, flags: number, mode = 0o644) => {
      if (flags & constants.O_CREAT) {
        if (entries.has(p)) throw new Error("exists");
        add(p);
        entries.get(p)!.mode = mode;
      }
      if (!entries.has(p) || entries.get(p)?.kind !== "file")
        throw new Error("not a regular file");
      const fd = nextDescriptor++;
      descriptors.set(fd, entries.get(p)!);
      return fd;
    },
    fstatSync: (fd: number) => stat(descriptors.get(fd)!),
    readSync: (
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number
    ) =>
      descriptors
        .get(fd)
        ?.bytes.copy(buffer, offset, position, position + length),
    fchmodSync: (fd: number, mode: number) => {
      descriptors.get(fd)!.mode = mode;
      return;
    },
    fsyncSync: (_fd: number) => undefined,
    closeSync: (fd: number) => {
      descriptors.delete(fd);
      return;
    },
    renameSync: (from: string, to: string) => {
      const prior = entries.get(to);
      if (prior) prior.nlink -= 1;
      entries.set(to, entries.get(from)!);
      return entries.delete(from);
    },
    unlinkSync: (p: string) => {
      entries.get(p)!.nlink -= 1;
      entries.delete(p);
      return;
    },
  };
  const spawn = vi.fn((file: string) => ({
    status: 0,
    stdout: file.includes("workerd") ? "workerd 2026" : "1.3.14\n",
  }));
  const require = vi.fn((name: string) =>
    name === "esbuild"
      ? { transformSync: () => ({ code: "compiled" }) }
      : { versions: { vips: "synthetic" } }
  );
  const run = (
    action: string,
    mode = "check",
    environment = "production",
    version = "v22.13.1"
  ) => {
    const process = {
      argv: ["node", "guard.mjs", action, mode, environment],
      version,
      env: {},
      exitCode: 0,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
    };
    // The exact in-image JS audit runs against synthetic in-memory ports only.
    // No filesystem, Docker, native binary, adapter, or provider is invoked.
    const body = deploymentGuard.replace(/^import .*;\n/gm, "");
    runInNewContext(
      body,
      {
        fs,
        path,
        crypto,
        Buffer,
        spawnSync: spawn,
        createRequire: () => require,
        process,
      },
      { timeout: 1000 }
    );
    return process;
  };
  return { entries, add, hardlink, descriptors, fs, spawn, require, run };
};

describe("in-image source dependency and toolchain audit", () => {
  it("accepts contained pnpm/workspace links and stable source/dependency/toolchain bytes", () => {
    const f = guardFixture();
    expect(f.run("prepare").exitCode).toBe(0);
    const result = f.run("verify");
    expect(result.exitCode).toBe(0);
    return expect(
      JSON.parse(result.stdout.write.mock.calls[0]![0])
    ).toMatchObject({
      sourceSha256: "a".repeat(64),
      authoritySha256: "b".repeat(64),
      policySha256: "c".repeat(64),
      dependencySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      toolchainSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it.each([
    [
      "esbuild@0.28.1/node_modules/esbuild/bin/esbuild",
      "@esbuild+linux-x64@0.28.1/node_modules/@esbuild/linux-x64/bin/esbuild",
    ],
    [
      "esbuild@0.25.12/node_modules/esbuild/bin/esbuild",
      "@esbuild+linux-x64@0.25.12/node_modules/@esbuild/linux-x64/bin/esbuild",
    ],
    [
      "workerd@1.20260722.1/node_modules/workerd/bin/workerd",
      "@cloudflare+workerd-linux-64@1.20260722.1/node_modules/@cloudflare/workerd-linux-64/bin/workerd",
    ],
  ])(
    "normalizes the reviewed native hardlink layout %s into independent identical executable bytes",
    (publicBin, nativeBin) => {
      const f = guardFixture();
      const first = `/workspace/node_modules/.pnpm/${publicBin}`;
      const second = `/workspace/node_modules/.pnpm/${nativeBin}`;
      f.add(first, "synthetic-native-executable");
      f.entries.get(first)!.mode = 0o755;
      f.hardlink(first, second);
      const originalInode = f.entries.get(first)?.ino;
      expect(f.entries.get(first)?.nlink).toBe(2);
      expect(f.run("prepare").exitCode).toBe(0);
      for (const p of [first, second]) {
        expect(f.entries.get(p)).toMatchObject({
          nlink: 1,
          mode: 0o755,
          uid: 65_532,
        });
        expect(f.entries.get(p)?.bytes.toString()).toBe(
          "synthetic-native-executable"
        );
        expect(f.entries.get(p)?.ino).not.toBe(originalInode);
      }
      expect(f.entries.get(first)?.ino).not.toBe(f.entries.get(second)?.ino);
      expect(f.run("verify").exitCode).toBe(0);
      expect(f.descriptors.size).toBe(0);
      expect(
        [...f.entries.keys()].some((p) => p.includes(".vertex-copy-"))
      ).toBe(false);
      f.entries.get(first)!.bytes = Buffer.from("changed-native-executable");
      expect(f.entries.get(second)?.bytes.toString()).toBe(
        "synthetic-native-executable"
      );
      return expect(f.run("verify").exitCode).toBe(1);
    }
  );

  it.each(["source", "store", "outside", "unaccounted", "foreign-owner"])(
    "never normalizes a hardlink with an unaudited %s alias",
    (kind) => {
      const f = guardFixture();
      const first = "/workspace/node_modules/native/bin/tool";
      f.add(first, "native");
      const other =
        kind === "source"
          ? "/workspace/package.json"
          : kind === "store"
            ? "/opt/offline-store/native"
            : kind === "outside"
              ? "/tmp/native"
              : "/workspace/node_modules/other/bin/tool";
      f.hardlink(first, other);
      if (kind === "unaccounted") f.entries.get(first)!.nlink += 1;
      if (kind === "foreign-owner") f.entries.get(first)!.uid = 0;
      const inode = f.entries.get(first)?.ino;
      expect(f.run("prepare").exitCode).toBe(1);
      expect(f.entries.get(first)?.ino).toBe(inode);
      return expect(f.descriptors.size).toBe(0);
    }
  );

  it.each(["write", "rename", "corrupt-copy"])(
    "fails a hardlink %s safely without leaking descriptors or deleting unrelated entries",
    (failure) => {
      const f = guardFixture();
      const first = "/workspace/node_modules/native/bin/tool";
      f.add(first, "native");
      f.hardlink(first, "/workspace/node_modules/other/bin/tool");
      f.add("/tmp/unrelated", "preserve");
      const write = f.fs.writeFileSync;
      if (failure === "rename") {
        vi.spyOn(f.fs, "renameSync").mockImplementation(() => {
          throw new Error("private-native-error");
        });
      } else
        vi.spyOn(f.fs, "writeFileSync").mockImplementation((target, bytes) => {
          if (typeof target === "number") {
            if (failure === "write") throw new Error("private-native-error");
            return write(target, Buffer.alloc(Buffer.byteLength(bytes), 33));
          }
          return write(target, bytes);
        });
      const result = f.run("prepare");
      expect(result.exitCode).toBe(1);
      expect(JSON.stringify(result.stderr.write.mock.calls)).not.toContain(
        "private-native-error"
      );
      expect(f.entries.get("/tmp/unrelated")?.bytes.toString()).toBe(
        "preserve"
      );
      expect(f.entries.get(first)?.nlink).toBe(2);
      expect(f.descriptors.size).toBe(0);
      return expect(
        [...f.entries.keys()].some((p) => p.includes(".vertex-copy-"))
      ).toBe(false);
    }
  );

  it("does not normalize new hardlinks introduced after sealing", () => {
    const f = guardFixture();
    expect(f.run("prepare").exitCode).toBe(0);
    const first =
      "/workspace/node_modules/.pnpm/sharp@0/node_modules/sharp/index.js";
    f.hardlink(first, "/workspace/node_modules/late/native");
    expect(f.run("verify").exitCode).toBe(1);
    return expect(f.entries.get(first)?.nlink).toBe(2);
  });

  it.each([
    "source",
    "dependency",
    "toolchain",
    "guard",
    "source-mode",
    "missing-source",
  ])("rejects post-preparation %s drift", (kind) => {
    const f = guardFixture();
    expect(f.run("prepare").exitCode).toBe(0);
    const targets: Record<string, string> = {
      source: "/workspace/package.json",
      dependency:
        "/workspace/node_modules/.pnpm/sharp@0/node_modules/sharp/index.js",
      toolchain: "/usr/local/bin/node",
      guard: "/opt/vertex/guard.mjs",
      "source-mode": "/workspace/package.json",
      "missing-source": "/workspace/package.json",
    };
    const target = targets[kind]!;
    if (kind === "missing-source") {
      f.entries.delete(target);
    } else if (kind === "source-mode") {
      f.entries.get(target)!.mode = 0o755;
    } else f.entries.get(target)!.bytes = Buffer.from("PRIVATE_SENTINEL");
    const result = f.run("verify");
    expect(result.exitCode).toBe(1);
    expect(JSON.stringify(result.stderr.write.mock.calls)).not.toContain(
      "PRIVATE_SENTINEL"
    );
    return expect(result.stdout.write).not.toHaveBeenCalled();
  });

  it.each([
    "absolute",
    "escape",
    "chained",
    "loop",
    "dangling",
    "hardlink",
    "special",
    "setuid",
    "source-link",
  ])("rejects %s filesystem aliases before sealing", (kind) => {
    const f = guardFixture();
    const target = "/workspace/apps/web/node_modules/unsafe";
    if (kind === "absolute")
      f.add(target, "", "link", "/workspace/package.json");
    if (kind === "escape") f.add(target, "", "link", "../../../../foreign");
    if (kind === "chained") {
      f.add(target, "", "link", "other");
      f.add(`${path.dirname(target)}/other`, "", "link", "/foreign");
    }
    if (kind === "loop") f.add(target, "", "link", "unsafe");
    if (kind === "dangling") f.add(target, "", "link", "missing");
    if (kind === "hardlink" || kind === "special" || kind === "setuid") {
      f.add(target, "sentinel", kind === "special" ? "special" : "file");
      if (kind === "hardlink") f.entries.get(target)!.nlink = 2;
      if (kind === "setuid") f.entries.get(target)!.mode = 0o4644;
    }
    if (kind === "source-link")
      f.add("/workspace/package.json", "", "link", "apps/web/package.json");
    return expect(f.run("prepare").exitCode).toBe(1);
  });

  it.each([
    "apps/web/dist/stale.js",
    "apps/web/.wrangler/deploy/config.json",
    "apps/web/node_modules/.vite-temp/stale.mjs",
    ".env",
    "unexpected.txt",
  ])("rejects stale generated or unexpected input %s", (file) => {
    const f = guardFixture();
    f.add(`/workspace/${file}`, "sentinel");
    return expect(f.run("prepare").exitCode).toBe(1);
  });

  it("requires exact native/runtime versions and prepared native outputs", () => {
    const f = guardFixture();
    expect(f.run("prepare", "check", "production", "v22.0.0").exitCode).toBe(1);
    f.spawn.mockReturnValue({ status: 0, stdout: "wrong-version" });
    expect(f.run("prepare").exitCode).toBe(1);
    const g = guardFixture();
    g.require.mockReturnValue({ versions: {} } as never);
    expect(g.run("prepare").exitCode).toBe(1);
    const h = guardFixture();
    h.entries.get(
      "/workspace/apps/web/node_modules/@vinext/cloudflare/package.json"
    )!.bytes = Buffer.from('{"version":"unreviewed"}');
    return expect(h.run("prepare").exitCode).toBe(1);
  });

  it.each(["check", "deploy"] as const)(
    "executes only fixed official %s arguments after verifying the sealed image",
    (mode) => {
      const f = guardFixture();
      expect(f.run("prepare").exitCode).toBe(0);
      f.spawn.mockClear();
      expect(f.run("run", mode, "staging").exitCode).toBe(0);
      return expect(f.spawn).toHaveBeenLastCalledWith(
        "/usr/local/bin/node",
        [
          "/workspace/apps/web/node_modules/@vinext/cloudflare/dist/cli.js",
          "deploy",
          ...(mode === "check" ? ["--dry-run"] : []),
          "--env",
          "staging",
        ],
        expect.objectContaining({
          cwd: "/workspace/apps/web",
          shell: false,
          stdio: ["ignore", "inherit", "inherit"],
        })
      );
    }
  );

  it("rejects unknown commands and prevents raw output on failures", () => {
    const f = guardFixture();
    expect(f.run("unknown").exitCode).toBe(1);
    expect(f.run("prepare").exitCode).toBe(0);
    expect(f.run("run", "skip-build").exitCode).toBe(1);
    return expect(f.run("run", "deploy", "preview").exitCode).toBe(1);
  });

  return it("keeps fixed offline preparation separate from the official deployment command", () => {
    expect(deploymentPreparationScript).toContain(
      "--offline --frozen-lockfile --ignore-scripts --package-import-method=copy"
    );
    expect(deploymentPreparationScript).toContain(
      "rebuild esbuild sharp workerd"
    );
    expect(deploymentPreparationScript).toContain(
      "/usr/local/bin/node --version"
    );
    expect(deploymentPreparationScript).toContain(
      "/usr/local/bin/bun --version"
    );
    expect(deploymentPreparationScript).not.toContain("bun-node-fallback");
    expect(deploymentPreparationScript).not.toContain("CLOUDFLARE_API_TOKEN");
    return expect(deploymentPreparationScript).not.toContain("deploy");
  });
});
