import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildCapnpConfig,
  discoverOutboundFetchFiles,
  normalizeBody,
  readWorkerdConfig,
  resolveWorkerdBinary,
  serializeFetchCall,
  sourceHasOutboundFetch,
  startWorkerdReplayHarness,
  withCapturedRequestCache,
  type WorkerdReplayHarness,
} from "./workerd-replay.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

const makeStubScript = (dir: string, name: string, lines: string[]): string => {
  const file = join(dir, name);
  writeFileSync(file, ["#!/bin/sh", ...lines, ""].join("\n"));
  chmodSync(file, 0o755);
  return file;
};

describe("workerd-replay helpers", () => {
  it("reads compatibility_date and compatibility_flags from apps/web/wrangler.jsonc", () => {
    const config = readWorkerdConfig(join(root, "apps/web/wrangler.jsonc"));
    expect(config.compatibilityDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(config.compatibilityFlags).toContain("nodejs_compat");
  });

  it("rejects malformed wrangler configs", () => {
    const dir = mkdtempSync(join(tmpdir(), "workerd-replay-config-"));
    try {
      const badPath = join(dir, "wrangler.jsonc");
      writeFileSync(badPath, '{"compatibility_date": "not-a-date"}');
      expect(() => readWorkerdConfig(badPath)).toThrow(
        /Invalid wrangler config/u
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("resolves the pinned workerd binary from apps/web and rejects invalid exports", () => {
    const binary = resolveWorkerdBinary(join(root, "apps/web/package.json"));
    expect(binary.binaryPath).toContain("workerd");
    expect(binary.version).toMatch(/^\d+\.\d+\.\d+/u);

    const dir = mkdtempSync(join(tmpdir(), "workerd-replay-resolve-"));
    try {
      const nm = join(dir, "node_modules");
      const wranglerDir = join(nm, "wrangler");
      const miniflareDir = join(nm, "miniflare");
      const workerdDir = join(nm, "workerd");
      mkdirSync(wranglerDir, { recursive: true });
      mkdirSync(miniflareDir, { recursive: true });
      mkdirSync(workerdDir, { recursive: true });
      const fakePkg = join(dir, "package.json");
      writeFileSync(fakePkg, '{"name":"fake"}');
      writeFileSync(join(wranglerDir, "package.json"), '{"name":"wrangler"}');
      writeFileSync(join(miniflareDir, "package.json"), '{"name":"miniflare"}');
      writeFileSync(
        join(workerdDir, "package.json"),
        '{"name":"workerd","main":"index.cjs"}'
      );
      writeFileSync(join(workerdDir, "index.cjs"), "module.exports = {};\n");
      expect(() => resolveWorkerdBinary(fakePkg)).toThrow(
        /Invalid workerd module export/u
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("normalizes supported body types and rejects unsupported ones", () => {
    expect(normalizeBody("hello")).toBe("hello");
    expect(normalizeBody(new URLSearchParams({ a: "1", b: "2" }))).toBe(
      "a=1&b=2"
    );
    expect(normalizeBody(new TextEncoder().encode("bytes"))).toBe("bytes");
    expect(normalizeBody(new TextEncoder().encode("buf").buffer)).toBe("buf");
    expect(() => normalizeBody(new Blob(["blob"]))).toThrow(
      /Unsupported fetch body type/u
    );
  });

  it("serializes string, URL and Request calls with Fetch-spec header replacement, referrer, and explicit cache tracking", async () => {
    const origin = "http://127.0.0.1:9999";

    const plain = await serializeFetchCall(
      "https://api.example.test/v1/items?limit=5",
      undefined,
      origin
    );
    expect(plain).toMatchObject({
      init: {},
      method: "GET",
      signalAborted: false,
      targetUrl: `${origin}/v1/items?limit=5`,
      viaRequest: false,
      withSignal: false,
    });

    const withInit = await serializeFetchCall(
      new URL("https://api.example.test/v1/post"),
      {
        body: "payload",
        cache: "no-store",
        credentials: "omit",
        headers: { "x-token": "t" },
        method: "POST",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: new AbortController().signal,
      },
      origin
    );
    expect(withInit.withSignal).toBe(true);
    expect(withInit.signalAborted).toBe(false);
    expect(withInit.method).toBe("POST");
    expect(withInit.init).toMatchObject({
      body: "payload",
      cache: "no-store",
      credentials: "omit",
      headers: { "x-token": "t" },
      method: "POST",
      redirect: "manual",
      referrerPolicy: "no-referrer",
    });

    const initWithNulls = {
      body: null,
      cache: undefined,
      headers: new Headers({ accept: "application/json" }),
      signal: null,
    } as unknown as RequestInit;
    const nullBodyAndUndefined = await serializeFetchCall(
      "https://api.example.test/v1/nulls",
      initWithNulls,
      origin
    );
    expect(nullBodyAndUndefined.withSignal).toBe(false);
    expect(nullBodyAndUndefined.init["body"]).toBeUndefined();
    expect(nullBodyAndUndefined.init["headers"]).toEqual({
      accept: "application/json",
    });

    const reqDefaultCache = new Request("https://app.example.test/r", {
      body: "req-body",
      headers: { "x-a": "1" },
      method: "POST",
      redirect: "manual",
      referrer: "https://app.example.test/origin",
    });
    const fromReq = await serializeFetchCall(
      reqDefaultCache,
      {
        headers: { "x-b": "2" },
        mode: "same-origin",
        priority: "high",
      } as RequestInit,
      origin
    );
    expect(fromReq.viaRequest).toBe(true);
    expect(fromReq.init["cache"]).toBeUndefined();
    expect(fromReq.init["referrer"]).toBe("https://app.example.test/origin");
    expect(fromReq.init["body"]).toBe("req-body");
    // Fetch spec: init.headers replaces input.headers.
    expect(fromReq.init["headers"]).toEqual({ "x-b": "2" });
    expect(fromReq.init["priority"]).toBe("high");

    const reqNoStore = new Request("https://app.example.test/no-store", {
      cache: "no-store",
      redirect: "manual",
    });
    const fromReqOverride = await serializeFetchCall(
      reqNoStore,
      { body: "override", method: "PUT", referrer: "" },
      origin
    );
    expect(fromReqOverride.init["cache"]).toBe("no-store");
    expect(fromReqOverride.init["body"]).toBe("override");
    expect(fromReqOverride.init["referrer"]).toBe("");
    expect(fromReqOverride.method).toBe("PUT");

    const reqGetNoBody = await serializeFetchCall(
      reqNoStore,
      undefined,
      origin
    );
    expect(reqGetNoBody.init["body"]).toBeUndefined();
    expect(reqGetNoBody.init["cache"]).toBe("no-store");
    expect(reqGetNoBody.init["referrer"]).toBeUndefined();

    // Explicit `cache: "default"` on new Request(...) is preserved through clone() and new Request(req).
    await withCapturedRequestCache(async () => {
      const explicitDefault = new Request("https://app.example.test/explicit", {
        cache: "default",
        redirect: "manual",
      });
      const cloned = explicitDefault.clone();
      const wrapped = new Request(cloned, { redirect: "manual" });
      const implicit = new Request("https://app.example.test/implicit", {
        redirect: "manual",
      });
      const serializedExplicit = await serializeFetchCall(
        wrapped,
        undefined,
        origin
      );
      const serializedImplicit = await serializeFetchCall(
        implicit,
        undefined,
        origin
      );
      expect(serializedExplicit.init["cache"]).toBe("default");
      expect(serializedImplicit.init["cache"]).toBeUndefined();
    });
  });

  it("builds a loopback-only Cap'n Proto workerd config", () => {
    const capnp = buildCapnpConfig({
      compatibilityDate: "2026-07-22",
      compatibilityFlags: ["nodejs_compat"],
    });
    expect(capnp).toContain('compatibilityDate = "2026-07-22"');
    expect(capnp).toContain('compatibilityFlags = ["nodejs_compat"]');
    expect(capnp).toContain('network = (allow = ["local"])');
    expect(capnp).toContain('globalOutbound = "loopback"');
  });

  it("detects runtime outbound fetch and HTTP SDK calls via TypeScript AST without string/comment corruption", () => {
    // Regression: accept header containing */* followed by JSDoc must not hide a fetch below it.
    expect(
      sourceHasOutboundFetch(
        "adapter.ts",
        [
          'const accept = "application/json, text/plain, */*";',
          "/** doc comment */",
          "export const run = () => globalThis.fetch(accept);",
        ].join("\n")
      )
    ).toBe(true);
    expect(
      sourceHasOutboundFetch("view.tsx", "export const A = () => <div />;")
    ).toBe(false);
    expect(
      sourceHasOutboundFetch("sdk.ts", "export const r = new Resend('k');")
    ).toBe(true);
    expect(
      sourceHasOutboundFetch("sdk2.ts", "export const g = new Groq({});")
    ).toBe(true);
    expect(
      sourceHasOutboundFetch(
        "prop.ts",
        "export const run = (c: { fetch: typeof fetch }) => c.fetch('https://a.test');"
      )
    ).toBe(true);
    expect(
      sourceHasOutboundFetch(
        "comment-only.ts",
        "// globalThis.fetch() and fetch() in comments only\nexport const x = 1;"
      )
    ).toBe(false);

    const files = discoverOutboundFetchFiles();
    expect(files).toContain("packages/api/src/server/options-chain-nasdaq.ts");
    expect(files).toContain("packages/analytics/src/server/posthog.ts");
    expect(files).toContain("packages/email/src/server/notification.ts");
    expect(files).toContain("packages/email/src/server/provider.ts");
    expect(files).toContain("packages/email/src/server/contact.ts");
    expect(files).toContain("packages/notifications/src/server/ntfy.ts");
    expect(files).toContain("packages/ai/src/server/groq.ts");
    expect(files).toContain("apps/web/src/lib/theme-api-timeout.ts");
    expect(files).not.toContain("packages/api/src/server/agent-ops.ts");
    expect(files).not.toContain("packages/api/src/server/flow-collect.ts");
  });
});

describe("workerd replay harness runtime", () => {
  let harness: WorkerdReplayHarness | undefined;

  beforeAll(async () => {
    harness = await startWorkerdReplayHarness();
  });

  afterAll(async () => {
    await harness?.close();
    // Second close is a safe no-op once the child process has exited.
    await harness?.close();
  });

  it("rejects redirect:'error', cache:'default', and new Request(..., { cache:'default' }) before hitting loopback", async () => {
    const active = harness as WorkerdReplayHarness;
    active.setLoopbackResponse({ mode: "200" });

    const redirectError = await active.replayRaw("/neg", {
      method: "GET",
      redirect: "error",
    });
    expect(redirectError.serverHits).toBe(0);
    expect(redirectError.workerdError?.name).toBe("TypeError");
    expect(redirectError.workerdError?.message).toMatch(/redirect/iu);

    const badCache = await active.replayRaw("/neg-cache", {
      cache: "default",
      method: "GET",
      redirect: "manual",
    });
    expect(badCache.serverHits).toBe(0);
    expect(badCache.workerdError?.name).toBe("TypeError");
    expect(badCache.workerdError?.message).toMatch(/cache/iu);

    await withCapturedRequestCache(async () => {
      const handle = active.createAdapterFetch();
      const badReq = new Request("https://app.example.test/cache-default", {
        cache: "default",
        redirect: "manual",
      });
      await expect(handle.fetch(badReq)).rejects.toThrow(
        /Unsupported cache mode: default/u
      );
      expect(handle.records[0]?.serverHits).toBe(0);
    });
  });

  it("replays 200 and 302 responses for manual, follow, Request inputs, and concurrent fetches", async () => {
    const active = harness as WorkerdReplayHarness;
    active.setLoopbackResponse({
      body: '{"ok":true}',
      mode: "200",
      status: 200,
    });
    const ok200 = await active.replayRaw(
      "/ok",
      {
        body: '{"ping":1}',
        cache: "no-store",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        method: "POST",
        redirect: "manual",
        referrerPolicy: "no-referrer",
      },
      { viaRequest: true, withSignal: true }
    );
    expect(ok200.workerdError).toBeNull();
    expect(ok200.responseStatus).toBe(200);
    expect(ok200.serverHits).toBe(1);
    expect(ok200.followedRedirect).toBe(false);

    active.setLoopbackResponse({ mode: "302" });
    const [manual302, follow302] = await Promise.all([
      active.replayRaw("/redir", { redirect: "manual" }),
      active.replayRaw("/redir", { redirect: "follow" }),
    ]);
    expect(manual302.workerdError).toBeNull();
    expect(manual302.responseStatus).toBe(302);
    expect(manual302.serverHits).toBe(1);
    expect(manual302.followedRedirect).toBe(false);

    expect(follow302.workerdError).toBeNull();
    expect(follow302.responseStatus).toBe(200);
    expect(follow302.serverHits).toBe(1);
    expect(follow302.followedRedirect).toBe(true);

    // Direct unprefixed and non-nested loopback requests are also served safely.
    const direct = await globalThis.fetch(`${active.loopbackOrigin}/raw`, {
      redirect: "manual",
    });
    expect(direct.status).toBe(302);
    const directTarget = await globalThis.fetch(
      `${active.loopbackOrigin}/__workerd-redirect-target`
    );
    expect(directTarget.status).toBe(200);
    const rootPrefixed = await globalThis.fetch(
      `${active.loopbackOrigin}/__r/no-slash`,
      { redirect: "manual" }
    );
    expect(rootPrefixed.status).toBe(302);

    // An aborted mid-body TCP connection is swallowed safely by the loopback server.
    const port = Number(new URL(active.loopbackOrigin).port);
    const socketClosed = Promise.withResolvers<void>();
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        "POST /raw HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\npart"
      );
      socket.destroy();
    });
    socket.once("close", () => socketClosed.resolve());
    await socketClosed.promise;
  });

  it("surfaces workerd TypeError and non-TypeError failures through createAdapterFetch", async () => {
    const active = harness as WorkerdReplayHarness;
    active.setLoopbackResponse({ body: "", mode: "200", status: 204 });
    const handle = active.createAdapterFetch();

    const empty = await handle.fetch("https://adapter.example.test/empty", {
      redirect: "manual",
    });
    expect(empty.status).toBe(204);

    await expect(
      handle.fetch("https://adapter.example.test/bad-redirect", {
        redirect: "error",
      })
    ).rejects.toThrow(TypeError);

    await expect(
      handle.fetch("https://adapter.example.test/aborted", {
        redirect: "manual",
        signal: AbortSignal.abort(),
      })
    ).rejects.toThrow(/AbortError/u);
  });

  it("handles spawn errors, early exit, malformed control-fd, closed control-fd, startup timeout, and SIGKILL fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "workerd-replay-faults-"));
    try {
      // 1. Spawn error (ENOENT)
      await expect(
        startWorkerdReplayHarness({
          binaryPath: join(dir, "does-not-exist"),
        })
      ).rejects.toThrow(/workerd failed to spawn/u);

      // 2. Early exit with blank control line, non-listen event, and stderr
      const earlyExit = makeStubScript(dir, "early-exit.sh", [
        'printf "\\n{\\"event\\":\\"starting\\"}\\n" >&3',
        'printf "simulated boot failure\\n" >&2',
        "exit 1",
      ]);
      await expect(
        startWorkerdReplayHarness({ binaryPath: earlyExit })
      ).rejects.toThrow(
        /workerd exited before listening \(code=1, signal=null\): simulated boot failure/u
      );

      // 2b. Loopback server listen failure cleans up cleanly before spawning workerd.
      await expect(
        startWorkerdReplayHarness({ listenHost: "256.256.256.256" })
      ).rejects.toThrow();

      // 3. Malformed JSON on control-fd
      const badJson = makeStubScript(dir, "bad-json.sh", [
        'printf "not-json\\n" >&3',
        "exec sleep 5",
      ]);
      await expect(
        startWorkerdReplayHarness({ binaryPath: badJson })
      ).rejects.toThrow(/malformed control-fd JSON/u);

      // 4. Control-fd closed without emitting listen while child stays alive briefly
      const closedControl = makeStubScript(dir, "closed-control.sh", [
        "exec 3>&-",
        "exec sleep 5",
      ]);
      await expect(
        startWorkerdReplayHarness({ binaryPath: closedControl })
      ).rejects.toThrow(/closed control-fd before listening/u);

      // 5. Real OS process timeout + SIGKILL fallback when child ignores SIGTERM
      const hungProcess = makeStubScript(dir, "hung.sh", [
        `exec ${JSON.stringify(process.execPath)} -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000);"`,
      ]);
      await expect(
        startWorkerdReplayHarness({
          binaryPath: hungProcess,
          startupTimeoutMs: 80,
          stopTimeoutMs: 50,
        })
      ).rejects.toThrow(/did not listen within 80ms/u);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
