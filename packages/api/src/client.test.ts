import { describe, expect, it } from "vitest";

import {
  type ApiCallObservation,
  createApiClient,
  observeApiCalls,
  trackResponseBody,
} from "./client.ts";

const observation: ApiCallObservation = {
  path: "assistant.send",
  phase: "open",
  requestId: "request-1",
  startedAt: 1,
  status: 200,
};

const collect = () => {
  const seen: ApiCallObservation[] = [];
  const stop = observeApiCalls((entry) => seen.push(entry));
  return { seen, stop };
};

describe("API call observation", () => {
  it("leaves responses untouched when nothing observes", async () => {
    const response = new Response("[]", { status: 500 });
    const client = createApiClient({
      baseUrl: "https://darkfactory.localhost",
      fetch: async () => response,
    });
    await expect(client.todos.list({})).rejects.toBeDefined();
  });

  it("reports open and closed at once for a reply without a body", async () => {
    const { seen, stop } = collect();
    const client = createApiClient({
      baseUrl: "https://darkfactory.localhost",
      fetch: async () => new Response(null, { status: 204 }),
    });
    await client.todos.list({}).catch(() => undefined);
    stop();
    expect(
      seen.map((entry) => [entry.path, entry.phase, entry.status])
    ).toEqual([
      ["todos.list", "open", 204],
      ["todos.list", "closed", 204],
    ]);
  });

  it("reports closed when a tracked body ends, fails or is cancelled", async () => {
    const { seen, stop } = collect();

    const ended = trackResponseBody(
      new Response("ok"),
      new Response("ok").body as ReadableStream<Uint8Array>,
      observation
    );
    await expect(ended.text()).resolves.toBe("ok");

    const failing = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.error(new Error("network")),
    });
    await expect(
      trackResponseBody(new Response("x"), failing, observation).text()
    ).rejects.toThrow("network");

    const endless = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
    });
    const cancelled = trackResponseBody(
      new Response("x", { headers: { "x-request-id": "request-1" } }),
      endless,
      observation
    );
    expect(cancelled.headers.get("x-request-id")).toBe("request-1");
    await cancelled.body?.cancel("stop");
    stop();

    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen.map((entry) => entry.phase))).toEqual(
      new Set(["closed"])
    );
  });
});
