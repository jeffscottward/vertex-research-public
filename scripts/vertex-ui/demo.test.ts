import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createDemoDependencies,
  DEV_VARS_MARKER,
  type DemoDependencies,
  DemoUsageError,
  demoBindings,
  parseDemoArgs,
  runDemo,
  runDemoEntrypoint,
  tailnetHostFromStatus,
  waitForOk,
} from "./demo.ts";

const STATUS_JSON = JSON.stringify({
  Self: { DNSName: "demo-host.tail000000.ts.net." },
});

type Fake = DemoDependencies & {
  written: Map<string, string>;
  removed: string[];
  tailscaleCalls: string[][];
  started: Array<{ dir: string; env: Readonly<Record<string, string>> }>;
  killed: string[];
  lines: string[];
  finish: (code: number | null) => void;
};

const fakeDependencies = (
  statuses: Readonly<Record<string, number | null>> = {},
  existing: string | null = null
): Fake => {
  const written = new Map<string, string>();
  const removed: string[] = [];
  const tailscaleCalls: string[][] = [];
  const started: Fake["started"] = [];
  const killed: string[] = [];
  const lines: string[] = [];
  const exit = Promise.withResolvers<number | null>();
  return {
    baseEnvironment: { HOME: "/home/demo", PATH: "/bin", SECRET_TOKEN: "x" },
    finish: exit.resolve,
    killed,
    lines,
    log: (line) => lines.push(line),
    onSignal: () => undefined,
    readText: async () => existing,
    removed,
    removeFile: async (path) => {
      removed.push(path);
    },
    repositoryRoot: "/repo",
    secret: () => "fixture-secret",
    sleep: async () => undefined,
    started,
    startServer: (dir, env) => {
      started.push({ dir, env });
      return {
        exited: exit.promise,
        kill: (signal) => {
          killed.push(signal);
          exit.resolve(143);
        },
      };
    },
    status: async (url) => (url in statuses ? (statuses[url] ?? null) : 200),
    tailscale: async (arguments_) => {
      tailscaleCalls.push([...arguments_]);
      return arguments_[0] === "status" ? STATUS_JSON : "";
    },
    tailscaleCalls,
    writePrivate: async (path, content) => {
      written.set(path, content);
    },
    written,
  };
};

describe("parseDemoArgs", () => {
  it("reads ports, optional host and --no-serve", () => {
    expect(parseDemoArgs(["--port", "9450", "--serve", "8450"])).toEqual({
      host: null,
      port: 9450,
      serve: 8450,
    });
    expect(
      parseDemoArgs(["--port=9451", "--no-serve", "--host=box.tail1.ts.net"])
    ).toEqual({ host: "box.tail1.ts.net", port: 9451, serve: null });
  });

  it.each([
    [[], "--port is required"],
    [["--port", "9450"], "exactly one"],
    [["--port", "9450", "--serve", "8450", "--no-serve"], "exactly one"],
    [["--port", "80", "--no-serve"], "1024 to 65535"],
    [["--port", "99999", "--no-serve"], "1024 to 65535"],
    [["--port", "9450", "--no-serve", "--host", "example.com"], "ts.net"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseDemoArgs(argv)).toThrow(DemoUsageError);
    expect(() => parseDemoArgs(argv)).toThrow(message);
  });
});

describe("demo helpers", () => {
  it("reads the tailnet host from tailscale status", () => {
    expect(tailnetHostFromStatus(STATUS_JSON)).toBe(
      "demo-host.tail000000.ts.net"
    );
    for (const json of ["null", "{}", '{"Self":{}}', '{"Self":{"DNSName":1}}'])
      expect(() => tailnetHostFromStatus(json)).toThrow("no tailnet DNS name");
  });

  it("writes development-only bindings with the lab on", () => {
    const bindings = demoBindings("https://h.ts.net:8450", () => "s3cret");
    expect(bindings.split("\n")).toEqual([
      DEV_VARS_MARKER,
      "APP_ENV=development",
      "APP_URL=https://h.ts.net:8450",
      "BETTER_AUTH_URL=https://h.ts.net:8450",
      "DATABASE_PROVIDER=postgres",
      "DATABASE_URL=postgresql://vertex_ui_lab@127.0.0.1:1/vertex_ui_lab_demo",
      "BETTER_AUTH_SECRET=s3cret",
      "CONTACT_THROTTLE_SECRET=s3cret",
      "EMAIL_PROVIDER=disabled",
      "EMAIL_TRANSPORT=disabled",
      "VERTEX_UI_LAB=on",
      "",
    ]);
  });

  it("polls until the URL answers 200", async () => {
    const answers = [null, 404, 200];
    const sleep = vi.fn(async () => undefined);
    await expect(
      waitForOk("http://x", {
        sleep,
        status: async () => answers.shift() ?? null,
      })
    ).resolves.toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
    await expect(
      waitForOk("http://x", { sleep, status: async () => 500 }, 2, 1)
    ).resolves.toBe(false);
  });
});

describe("runDemo", () => {
  it("starts the lab, serves it on the tailnet and waits for the server", async () => {
    const fake = fakeDependencies();
    const done = runDemo(parseDemoArgs(["--port=9450", "--serve=8450"]), fake);
    await vi.waitFor(() =>
      expect(fake.lines).toContain(
        "Demo (tailnet only): https://demo-host.tail000000.ts.net:8450/lab"
      )
    );
    // A signal-killed server has no exit code: report failure.
    fake.finish(null);
    await expect(done).resolves.toBe(1);
    expect(fake.written.get("/repo/apps/web/.dev.vars")).toContain(
      "APP_URL=https://demo-host.tail000000.ts.net:8450"
    );
    expect(fake.removed).toEqual(["/repo/apps/web/.dev.vars"]);
    expect(fake.started).toEqual([
      {
        dir: "/repo/apps/web",
        env: {
          __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: "demo-host.tail000000.ts.net",
          BROWSER: "none",
          CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
          HOME: "/home/demo",
          HOST: "127.0.0.1",
          NO_COLOR: "1",
          NODE_ENV: "development",
          PATH: "/bin",
          PORT: "9450",
          WRANGLER_SEND_METRICS: "false",
        },
      },
    ]);
    expect(fake.tailscaleCalls).toEqual([
      ["status", "--json"],
      ["serve", "--bg", "--https=8450", "http://127.0.0.1:9450"],
      ["serve", "--https=8450", "off"],
    ]);
    expect(fake.lines).toContain(
      "Tailnet serve removed: https://demo-host.tail000000.ts.net:8450"
    );
  });

  it("runs local-only with --no-serve and a given host", async () => {
    const fake = fakeDependencies({}, `${DEV_VARS_MARKER}\nOLD=1\n`);
    const done = runDemo(
      parseDemoArgs(["--port=9451", "--no-serve", "--host=box.tail1.ts.net"]),
      fake
    );
    await vi.waitFor(() =>
      expect(fake.lines).toContain("Local lab: http://127.0.0.1:9451/lab")
    );
    fake.finish(null);
    await expect(done).resolves.toBe(1);
    expect(fake.tailscaleCalls).toEqual([]);
    expect(fake.written.get("/repo/apps/web/.dev.vars")).toContain(
      "APP_URL=http://127.0.0.1:9451"
    );
  });

  it("refuses a .dev.vars it did not write", async () => {
    await expect(
      runDemo(
        parseDemoArgs(["--port=9450", "--no-serve"]),
        fakeDependencies({}, "DATABASE_URL=real\n")
      )
    ).rejects.toThrow("was not written by this demo");
  });

  it("stops the server when the local or tailnet URL does not answer", async () => {
    const local = fakeDependencies({ "http://127.0.0.1:9450/lab": 500 });
    await expect(
      runDemo(parseDemoArgs(["--port=9450", "--serve=8450"]), local)
    ).resolves.toBe(1);
    expect(local.killed).toEqual(["SIGTERM"]);
    const tailnet = fakeDependencies({
      "https://demo-host.tail000000.ts.net:8450/lab": null,
    });
    await expect(
      runDemo(parseDemoArgs(["--port=9450", "--serve=8450"]), tailnet)
    ).resolves.toBe(1);
    expect(tailnet.lines).toContain(
      "The tailnet URL did not answer: https://demo-host.tail000000.ts.net:8450/lab"
    );
    expect(tailnet.tailscaleCalls.at(-1)).toEqual([
      "serve",
      "--https=8450",
      "off",
    ]);
    expect(local.tailscaleCalls).toEqual([["status", "--json"]]);
  });

  it("stops the server and removes the bindings when tailscale serve fails", async () => {
    const fake = fakeDependencies();
    const failing = {
      ...fake,
      tailscale: async (arguments_: readonly string[]) => {
        fake.tailscaleCalls.push([...arguments_]);
        if (arguments_[0] === "serve") throw new Error("serve refused");
        return STATUS_JSON;
      },
    };
    await expect(
      runDemo(parseDemoArgs(["--port=9450", "--serve=8450"]), failing)
    ).rejects.toThrow("serve refused");
    expect(fake.killed).toEqual(["SIGTERM"]);
    expect(fake.removed).toEqual(["/repo/apps/web/.dev.vars"]);
    expect(fake.tailscaleCalls).toEqual([
      ["status", "--json"],
      ["serve", "--bg", "--https=8450", "http://127.0.0.1:9450"],
    ]);
  });

  it("forwards SIGINT, SIGTERM and SIGHUP, then still removes the serve", async () => {
    const handlers = new Map<string, () => void>();
    const base = fakeDependencies();
    const fake = {
      ...base,
      onSignal: (signal: NodeJS.Signals, handler: () => void) => {
        handlers.set(signal, handler);
      },
    };
    const done = runDemo(parseDemoArgs(["--port=9450", "--serve=8450"]), fake);
    await vi.waitFor(() =>
      expect(base.lines).toContain(
        "Demo (tailnet only): https://demo-host.tail000000.ts.net:8450/lab"
      )
    );
    expect([...handlers.keys()]).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    handlers.get("SIGHUP")?.();
    await expect(done).resolves.toBe(143);
    expect(base.killed).toEqual(["SIGHUP"]);
    expect(base.tailscaleCalls.at(-1)).toEqual([
      "serve",
      "--https=8450",
      "off",
    ]);
    expect(base.removed).toEqual(["/repo/apps/web/.dev.vars"]);
    handlers.get("SIGINT")?.();
    handlers.get("SIGTERM")?.();
    expect(base.killed).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
  });
});

describe("createDemoDependencies", () => {
  let directory = "";
  let server: ReturnType<typeof createServer> | undefined;
  let origin = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "vertex-ui-demo-"));
    server = createServer((request, response) => {
      response.statusCode = request.url === "/lab" ? 200 : 404;
      response.end();
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server?.close();
    await rm(directory, { recursive: true });
  });

  it("reads, writes private files, checks URLs and sleeps", async () => {
    const log = vi.fn();
    const onSignal = vi.fn();
    const dependencies = createDemoDependencies(
      directory,
      { PATH: process.env["PATH"] },
      log,
      onSignal,
      { server: ["node", "-e", "process.exit(3)"], tailscale: "echo" }
    );
    const path = join(directory, ".dev.vars");
    await expect(dependencies.readText(path)).resolves.toBeNull();
    await dependencies.writePrivate(path, "A=1\n");
    await expect(dependencies.readText(path)).resolves.toBe("A=1\n");
    expect((await stat(path)).mode % 0o1000).toBe(0o600);
    await dependencies.removeFile(path);
    await dependencies.removeFile(path);
    await expect(dependencies.readText(path)).resolves.toBeNull();
    await expect(dependencies.tailscale(["status", "--json"])).resolves.toBe(
      "status --json\n"
    );
    await expect(dependencies.status(`${origin}/lab`)).resolves.toBe(200);
    await expect(dependencies.status(`${origin}/nope`)).resolves.toBe(404);
    await expect(
      dependencies.status("http://127.0.0.1:1/")
    ).resolves.toBeNull();
    await expect(dependencies.sleep(1)).resolves.toBeUndefined();
    expect(dependencies.secret()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(dependencies.secret()).not.toBe(dependencies.secret());
    const child = dependencies.startServer(directory, {
      PATH: process.env["PATH"] ?? "",
    });
    await expect(child.exited).resolves.toBe(3);
    const missing = createDemoDependencies(directory, {}, log, onSignal, {
      server: ["vertex-ui-lab-no-such-binary"],
      tailscale: "echo",
    }).startServer(directory, {});
    await expect(missing.exited).resolves.toBe(1);
    missing.kill("SIGTERM");
    expect(dependencies.repositoryRoot).toBe(directory);
    dependencies.log("x");
    expect(log).toHaveBeenCalledWith("x");
    await writeFile(join(directory, "keep"), "");
    expect(await readFile(join(directory, "keep"), "utf8")).toBe("");
  });
});

describe("runDemoEntrypoint", () => {
  it("runs the real dependencies and prints the local lab URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "vertex-ui-demo-root-"));
    await mkdir(join(root, "apps/web"), { recursive: true });
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.end();
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const { port } = server.address() as AddressInfo;
    const out: string[] = [];
    const exitState: { exitCode?: number | string | null } = {};
    try {
      await runDemoEntrypoint({
        argv: [
          "bun",
          "demo.ts",
          `--port=${port}`,
          "--no-serve",
          "--host=box.tail1.ts.net",
        ],
        commands: {
          server: ["node", "-e", "setTimeout(() => process.exit(0), 300)"],
          tailscale: "false",
        },
        environment: { PATH: process.env["PATH"] },
        exitState,
        isMain: true,
        onSignal: vi.fn(),
        repositoryRoot: root,
        stderr: { write: vi.fn() },
        stdout: { write: (text) => out.push(text) },
      });
      expect(out).toEqual([`Local lab: http://127.0.0.1:${port}/lab\n`]);
      expect(exitState.exitCode).toBe(0);
      // The per-run bindings are deleted when the server exits.
      expect(
        await readFile(join(root, "apps/web/.dev.vars"), "utf8").catch(
          () => null
        )
      ).toBeNull();
    } finally {
      server.close();
      await rm(root, { recursive: true });
    }
  });

  it("does nothing when imported", async () => {
    const exitState: { exitCode?: number | string | null } = {};
    const write = vi.fn();
    await runDemoEntrypoint({
      argv: [],
      environment: {},
      exitState,
      isMain: false,
      onSignal: vi.fn(),
      repositoryRoot: "/repo",
      stderr: { write },
      stdout: { write },
    });
    expect(write).not.toHaveBeenCalled();
    expect(exitState.exitCode).toBeUndefined();
  });

  it("returns 2 for usage errors and 1 for runtime errors", async () => {
    const run = async (argv: string[], repositoryRoot: string) => {
      const exitState: { exitCode?: number | string | null } = {};
      const errors: string[] = [];
      await runDemoEntrypoint({
        argv: ["bun", "demo.ts", ...argv],
        commands: { server: ["false"], tailscale: "false" },
        environment: {},
        exitState,
        isMain: true,
        onSignal: vi.fn(),
        repositoryRoot,
        stderr: { write: (text) => errors.push(text) },
        stdout: { write: vi.fn() },
      });
      return { code: exitState.exitCode, errors };
    };
    expect(await run([], "/repo")).toEqual({
      code: 2,
      errors: ["--port is required\n"],
    });
    const failed = await run(["--port=9450", "--serve=8450"], "/repo");
    expect(failed.code).toBe(1);
    expect(failed.errors[0]).toContain("Command failed: false");
    const exitState: { exitCode?: number | string | null } = {};
    const errors: string[] = [];
    const root = await mkdtemp(join(tmpdir(), "vertex-ui-demo-throw-"));
    await mkdir(join(root, "apps/web"), { recursive: true });
    await runDemoEntrypoint({
      argv: [
        "bun",
        "demo.ts",
        "--port=9450",
        "--no-serve",
        "--host=b.tail1.ts.net",
      ],
      commands: { server: ["false"], tailscale: "false" },
      environment: {},
      exitState,
      isMain: true,
      onSignal: () => {
        throw "boom";
      },
      repositoryRoot: root,
      stderr: { write: (text) => errors.push(text) },
      stdout: { write: vi.fn() },
    });
    await rm(root, { recursive: true });
    expect({ code: exitState.exitCode, errors }).toEqual({
      code: 1,
      errors: ["boom\n"],
    });
  });
});
