// @vitest-environment jsdom
import type { ClickLogRecordInput } from "@darkfactory/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createKeepaliveSend,
  installClickLog,
  readBuildSha,
} from "./install.ts";
import { CLICK_LOG_FLUSH_MS } from "./recorder.ts";

const TAB = "0f0e8a52-1d6e-4c55-9d4b-3c1f2b8b5a11";
const globals = globalThis as { __VERTEX_BUILD_SHA__?: unknown };

afterEach(() => {
  vi.useRealTimers();
  delete globals.__VERTEX_BUILD_SHA__;
  document.body.innerHTML = "";
});

describe("readBuildSha", () => {
  it("uses the Vite-defined commit and falls back to unknown", () => {
    expect(readBuildSha()).toBe("unknown");
    globals.__VERTEX_BUILD_SHA__ = "0123abc";
    expect(readBuildSha()).toBe("0123abc");
    globals.__VERTEX_BUILD_SHA__ = "not a sha";
    expect(readBuildSha()).toBe("unknown");
  });
});

describe("createKeepaliveSend", () => {
  it("posts the batch through the oRPC client with keepalive", async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ json: { accepted: 1 } })
    );
    const send = createKeepaliveSend("https://vertex.test", fetcher);
    await expect(
      send({ buildSha: "unknown", events: [], tabId: TAB })
    ).resolves.toEqual({ accepted: 1 });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://vertex.test/api/orpc/clickLog/record");
    expect(init).toMatchObject({
      credentials: "same-origin",
      keepalive: true,
      method: "POST",
    });
    expect(String(init?.body)).toContain(TAB);
  });
});

describe("installClickLog", () => {
  it("records clicks and submits, flushes on page hide and stops cleanly", () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_input: ClickLogRecordInput) => ({}));
    document.body.innerHTML = `
      <a href="/dashboard">Dashboard</a>
      <form aria-label="Assistant message"><textarea>typed</textarea><button type="submit">Send</button></form>
      <p>plain</p>`;
    const stop = installClickLog(window, {
      buildSha: "abc1234",
      send,
      tabId: TAB,
    });

    document
      .querySelector("a")
      ?.addEventListener("click", (event) => event.preventDefault());
    document.querySelector("a")?.click();
    document.querySelector("p")?.click();
    document
      .querySelector("form")
      ?.addEventListener("submit", (event) => event.preventDefault());
    document
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    document.querySelector("textarea")?.click();
    document
      .querySelector("p")
      ?.dispatchEvent(new Event("submit", { bubbles: true }));

    vi.advanceTimersByTime(CLICK_LOG_FLUSH_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].events.map((event) => event.label)).toEqual([
      "Dashboard",
    ]);

    window.dispatchEvent(new Event("pagehide"));
    expect(send.mock.calls[1]?.[0].events).toEqual([
      expect.objectContaining({ kind: "submit", label: "Assistant message" }),
    ]);

    document.querySelector("a")?.click();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(send).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(send).toHaveBeenCalledTimes(3);

    document.querySelector("a")?.click();
    stop();
    expect(send).toHaveBeenCalledTimes(4);
    document.querySelector("a")?.click();
    window.dispatchEvent(new Event("pagehide"));
    expect(send).toHaveBeenCalledTimes(4);
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("builds its own sender, tab id and build commit by default", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const stop = installClickLog(window);
    document.body.innerHTML = "<button>Open</button>";
    document.querySelector("button")?.click();
    window.dispatchEvent(new Event("pagehide"));
    stop();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });
});
