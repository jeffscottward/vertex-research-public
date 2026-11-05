import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentApiKeyPlugin } from "./server.ts";

// The effective agent key limit (infra/research-worker/README.md#request-budget): the api-key
// plugin counts accepted requests per key and resets the count only after one window (60 s) with
// no accepted request. Requests less than 60 s apart never reset it, so 600 is a limit per busy
// stretch, not per minute. The Nautilus worker's request budget depends on this behavior.

const T0 = Date.parse("2026-11-05T00:00:00.000Z");

afterEach(() => {
  vi.useRealTimers();
});

const keyWithPlugin = async () => {
  const auth = betterAuth({
    baseURL: "http://localhost",
    database: memoryAdapter({
      account: [],
      apiKeys: [],
      session: [],
      user: [],
      verification: [],
    }),
    plugins: [createAgentApiKeyPlugin()],
    secret: "test-only-secret-with-enough-length-0123456789",
  });
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser(
    { email: "operator@domain.test", emailVerified: true, name: "operator" },
    { method: "admin" }
  );
  const created = await auth.api.createApiKey({
    body: { name: "probe", userId: user.id },
  });
  let now = T0;
  /** Verifies the key `stepMs` after the previous call; "ok" or the refusal code. */
  const verifyAfter = async (stepMs: number): Promise<string> => {
    now += stepMs;
    vi.setSystemTime(now);
    const result = await auth.api.verifyApiKey({ body: { key: created.key } });
    return result.valid ? "ok" : (result.error?.code ?? "invalid");
  };
  return { verifyAfter };
};

/** Accepted calls before the first refusal, at most `limit` calls. */
const acceptedBeforeRefusal = async (
  verifyAfter: (stepMs: number) => Promise<string>,
  stepMs: number,
  limit: number
): Promise<number> => {
  for (let call = 0; call < limit; call += 1)
    if ((await verifyAfter(stepMs)) !== "ok") return call;
  return limit;
};

describe("agent API key limiter", () => {
  it("refuses after 600 accepted requests that come less than 60 s apart", {
    timeout: 60_000,
  }, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const { verifyAfter } = await keyWithPlugin();
    // 3 s polling: 600 accepted (30 minutes), then refused.
    expect(await acceptedBeforeRefusal(verifyAfter, 3000, 700)).toBe(600);
    // Refusals do not count as requests: the count resets 60 s after the last accepted one,
    // so 19 more calls at 3 s are refused (the 19 production 429s of 2026-11-05).
    let refused = 1;
    while ((await verifyAfter(3000)) !== "ok") refused += 1;
    expect(refused).toBe(20);
    // 40 s polling never resets the count either: refused after 600 again (6.7 hours).
    await verifyAfter(61_000);
    expect(await acceptedBeforeRefusal(verifyAfter, 40_000, 700)).toBe(599);
    // More than 60 s with no accepted request resets it.
    expect(await verifyAfter(61_000)).toBe("ok");
    expect(await acceptedBeforeRefusal(verifyAfter, 70_000, 700)).toBe(700);
  });
});
