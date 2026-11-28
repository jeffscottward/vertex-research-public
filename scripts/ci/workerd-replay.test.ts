import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  startWorkerdReplayHarness,
  type WorkerdReplayHarness,
} from "./workerd-replay.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

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

  it("serializes string, URL and Request fetch calls while preserving init options", async () => {
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
    expect(fromReq.init["body"]).toBe("req-body");
    expect(fromReq.init["headers"]).toMatchObject({
      "x-a": "1",
      "x-b": "2",
    });
    expect(fromReq.init["priority"]).toBe("high");

    const reqNoStore = new Request("https://app.example.test/no-store", {
      cache: "no-store",
      redirect: "manual",
    });
    const fromReqOverride = await serializeFetchCall(
      reqNoStore,
      { body: "override", method: "PUT" },
      origin
    );
    expect(fromReqOverride.init["cache"]).toBe("no-store");
    expect(fromReqOverride.init["body"]).toBe("override");
    expect(fromReqOverride.method).toBe("PUT");

    const reqGetNoBody = await serializeFetchCall(
      reqNoStore,
      undefined,
      origin
    );
    expect(reqGetNoBody.init["body"]).toBeUndefined();
    expect(reqGetNoBody.init["cache"]).toBe("no-store");
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

  it("discovers tracked non-test outbound fetch files", () => {
    const files = discoverOutboundFetchFiles();
    expect(files).toContain("packages/api/src/server/options-chain-nasdaq.ts");
    expect(files).toContain("packages/analytics/src/server/posthog.ts");
    expect(files).toContain("packages/email/src/server/notification.ts");
    expect(files).toContain("packages/notifications/src/server/ntfy.ts");
    expect(files).not.toContain("packages/api/src/server/agent-ops.ts");
    expect(files).not.toContain("packages/api/src/server/flow-collect.ts");
  });
});

describe("workerd replay harness runtime", () => {
  let harness: WorkerdReplayHarness;

  beforeAll(async () => {
    harness = await startWorkerdReplayHarness();
  });

  afterAll(async () => {
    await harness.close();
    // Second close is a safe no-op once the child process has exited.
    await harness.close();
  });

  it("rejects redirect:'error' and unsupported cache modes before hitting loopback", async () => {
    harness.setLoopbackResponse({ mode: "200" });

    const redirectError = await harness.replayRaw("/neg", {
      method: "GET",
      redirect: "error",
    });
    expect(redirectError.serverHits).toBe(0);
    expect(redirectError.workerdError?.name).toBe("TypeError");
    expect(redirectError.workerdError?.message).toMatch(/redirect/iu);

    const badCache = await harness.replayRaw("/neg-cache", {
      cache: "default",
      method: "GET",
      redirect: "manual",
    });
    expect(badCache.serverHits).toBe(0);
    expect(badCache.workerdError?.name).toBe("TypeError");
    expect(badCache.workerdError?.message).toMatch(/cache/iu);
  });

  it("replays 200 and 302 responses for manual and follow modes and Request inputs", async () => {
    harness.setLoopbackResponse({
      body: '{"ok":true}',
      mode: "200",
      status: 200,
    });
    const ok200 = await harness.replayRaw(
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

    harness.setLoopbackResponse({ mode: "302" });
    const manual302 = await harness.replayRaw("/redir", {
      redirect: "manual",
    });
    expect(manual302.workerdError).toBeNull();
    expect(manual302.responseStatus).toBe(302);
    expect(manual302.serverHits).toBe(1);
    expect(manual302.followedRedirect).toBe(false);

    const follow302 = await harness.replayRaw("/redir", {
      redirect: "follow",
    });
    expect(follow302.workerdError).toBeNull();
    expect(follow302.responseStatus).toBe(200);
    expect(follow302.serverHits).toBe(1);
    expect(follow302.followedRedirect).toBe(true);
  });

  it("surfaces workerd TypeError and non-TypeError failures through createAdapterFetch", async () => {
    harness.setLoopbackResponse({ body: "", mode: "200", status: 204 });
    const handle = harness.createAdapterFetch();

    const empty = await handle.fetch("https://adapter.example.test/empty", {
      redirect: "manual",
    });
    expect(empty.status).toBe(204);

    await expect(
      handle.fetch("https://adapter.example.test/bad-redirect", {
        redirect: "error",
      })
    ).rejects.toThrow(TypeError);

    // An aborted signal triggers workerd's AbortError (non-TypeError).
    await expect(
      handle.fetch("https://adapter.example.test/aborted", {
        redirect: "manual",
        signal: AbortSignal.abort(),
      })
    ).rejects.toThrow(/AbortError/u);
  });

  it("cleans up when the workerd process exits before listening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "workerd-replay-early-exit-"));
    try {
      const stub = join(dir, "stub-workerd.sh");
      writeFileSync(
        stub,
        [
          "#!/bin/sh",
          'printf "\\n{\\"event\\":\\"starting\\"}\\n" >&3',
          'printf "simulated boot failure\\n" >&2',
          "exit 1",
          "",
        ].join("\n")
      );
      chmodSync(stub, 0o755);
      await expect(
        startWorkerdReplayHarness({ binaryPath: stub })
      ).rejects.toThrow(
        /workerd exited before listening \(code=1, signal=null\): simulated boot failure/u
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
