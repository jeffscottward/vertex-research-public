import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@darkfactory/api/client";
import {
  createBrowserChartReadTransport,
  createChartReadTransport,
} from "./transport.ts";

// Synthetic fixtures only; no provider, broker, DB or network. After the
// 2026-10-30 removal of exact-ID lookups the browser reads only the scoped
// module catalog through this transport.

const api = vi.hoisted(() => ({ createApiClient: vi.fn() }));
vi.mock("@darkfactory/api/client", () => ({
  createApiClient: api.createApiClient,
}));

const scope = {
  accountAlias: "synthetic-account",
  environment: "research",
} as const;
const signal = () => new AbortController().signal;
const wireError = (code = "SERVICE_UNAVAILABLE", status = 503) => ({
  defined: true,
  code,
  status,
  message: "private upstream detail",
  data: { private: "must not escape" },
});
const fixture = () => {
  const modules = vi.fn(async (): Promise<unknown> => {
    throw wireError();
  });
  const client = { vertex: { scoped: { modules } } } as unknown as ApiClient;
  return { modules, client, transport: createChartReadTransport(client) };
};

afterEach(() => {
  vi.unstubAllGlobals();
  api.createApiClient.mockReset();
});

describe("scoped module catalog transport", () => {
  it("forwards only the exact scope and signal and returns the parsed catalog", async () => {
    const { modules, transport } = fixture();
    modules.mockResolvedValue([]);
    const abort = signal();
    await expect(transport.scoped(scope).modules(abort)).resolves.toEqual([]);
    expect(modules).toHaveBeenCalledExactlyOnceWith(scope, { signal: abort });
  });

  it("rejects a malformed catalog and an invalid scope", async () => {
    const { modules, transport } = fixture();
    modules.mockResolvedValue({ modules: [] });
    await expect(
      transport.scoped(scope).modules(signal())
    ).rejects.toMatchObject({ kind: "malformed" });
    expect(() =>
      transport.scoped({ accountAlias: " bad ", environment: "research" })
    ).toThrow();
    expect(() =>
      transport.scoped({ ...scope, isAdmin: true } as never)
    ).toThrow();
  });

  it("classifies upstream failures without leaking upstream data", async () => {
    const { modules, transport } = fixture();
    for (const [code, status, kind] of [
      ["UNAUTHORIZED", 401, "unauthorized"],
      ["FORBIDDEN", 403, "denied"],
      ["SERVICE_UNAVAILABLE", 503, "unavailable"],
    ] as const) {
      modules.mockRejectedValue(wireError(code, status));
      const failure = transport.scoped(scope).modules(signal());
      await expect(failure).rejects.toMatchObject({ kind });
      await expect(failure).rejects.not.toHaveProperty("data");
    }
  });

  it("checks cancellation before dispatch, after a response and after a rejection", async () => {
    const { modules, transport } = fixture();
    const before = new AbortController();
    before.abort();
    await expect(
      transport.scoped(scope).modules(before.signal)
    ).rejects.toMatchObject({ kind: "suspended" });
    expect(modules).not.toHaveBeenCalled();
    for (const outcome of ["resolve", "reject"] as const) {
      const late = new AbortController();
      modules.mockImplementationOnce(async () => {
        late.abort();
        if (outcome === "reject") throw wireError();
        return [];
      });
      await expect(
        transport.scoped(scope).modules(late.signal)
      ).rejects.toMatchObject({ kind: "suspended" });
    }
  });

  it("creates one browser API client lazily, on the first read", async () => {
    vi.stubGlobal("window", { location: { origin: "https://vertex.test" } });
    const modules = vi.fn(async () => []);
    api.createApiClient.mockReturnValue({ vertex: { scoped: { modules } } });
    const transport = createBrowserChartReadTransport();
    expect(api.createApiClient).not.toHaveBeenCalled();
    await transport.scoped(scope).modules(signal());
    await transport.scoped(scope).modules(signal());
    expect(api.createApiClient).toHaveBeenCalledExactlyOnceWith({
      baseUrl: "https://vertex.test",
    });
    expect(modules).toHaveBeenCalledTimes(2);
  });
});
