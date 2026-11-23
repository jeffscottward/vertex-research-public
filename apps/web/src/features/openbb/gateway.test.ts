import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  const procedure = () => vi.fn(async (input: unknown) => input);
  const openbb = {
    cot: procedure(),
    events: procedure(),
    macro: procedure(),
    sec: procedure(),
    shorts: procedure(),
    status: procedure(),
    volContext: procedure(),
  };
  return { createApiClient: vi.fn(() => ({ openbb })), openbb };
});
vi.mock("@darkfactory/api", () => ({
  createApiClient: api.createApiClient,
}));

import { createBrowserOpenbbGateway } from "./gateway.ts";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { location: { origin: "https://vertex.test" } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createBrowserOpenbbGateway", () => {
  it("creates one client on first use and sends each read's input", async () => {
    const gateway = createBrowserOpenbbGateway();
    expect(api.createApiClient).not.toHaveBeenCalled();
    await gateway.cot(8);
    await gateway.events("2026-11-01", "2026-11-30");
    await gateway.sec("NVDA");
    await gateway.shorts("NVDA", 30);
    await gateway.status();
    await gateway.volContext();
    expect(api.createApiClient).toHaveBeenCalledTimes(1);
    expect(api.createApiClient).toHaveBeenCalledWith({
      baseUrl: "https://vertex.test",
    });
    expect(api.openbb.cot).toHaveBeenCalledWith({ weeks: 8 });
    expect(api.openbb.events).toHaveBeenCalledWith({
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect(api.openbb.sec).toHaveBeenCalledWith({ symbol: "NVDA" });
    expect(api.openbb.shorts).toHaveBeenCalledWith({
      days: 30,
      symbol: "NVDA",
    });
    expect(api.openbb.status).toHaveBeenCalledWith({});
    expect(api.openbb.volContext).toHaveBeenCalledWith({});
  });

  it("sends ids to the macro read only when given", async () => {
    const gateway = createBrowserOpenbbGateway();
    await gateway.macro("2026-01-01");
    expect(api.openbb.macro).toHaveBeenLastCalledWith({ from: "2026-01-01" });
    await gateway.macro("2026-01-01", ["CME_ES_OI"]);
    expect(api.openbb.macro).toHaveBeenLastCalledWith({
      from: "2026-01-01",
      ids: ["CME_ES_OI"],
    });
  });
});
