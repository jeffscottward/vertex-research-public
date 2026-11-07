import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parseServerEnv: vi.fn((): Record<string, unknown> => ({})),
}));

vi.mock("@darkfactory/config/server", () => ({
  parseServerEnv: mocks.parseServerEnv,
}));

import { resolveJournalSource } from "./trade-journal-source.ts";

afterEach(() => {
  mocks.parseServerEnv.mockReset();
});

describe("resolveJournalSource", () => {
  it("prefers ibkr-monitor, the reader /portfolio uses", () => {
    mocks.parseServerEnv.mockReturnValue({
      IBKR_MONITOR_URL: "http://127.0.0.1:3461",
      VERTEX_PORTFOLIO_URL: "http://127.0.0.1:3460",
    });
    const env = { NODE_ENV: "test" };
    expect(resolveJournalSource(env)).toBe("ibkr-monitor");
    expect(mocks.parseServerEnv).toHaveBeenCalledWith(env);
  });

  it("falls back to the vertex-portfolio service", () => {
    mocks.parseServerEnv.mockReturnValue({
      VERTEX_PORTFOLIO_URL: "http://127.0.0.1:3460",
    });
    expect(resolveJournalSource({})).toBe("portfolio-monitor");
  });

  it("is null when neither service is set or the environment is invalid", () => {
    mocks.parseServerEnv.mockReturnValue({});
    expect(resolveJournalSource()).toBeNull();
    expect(mocks.parseServerEnv).toHaveBeenCalledWith(process.env);
    mocks.parseServerEnv.mockImplementation(() => {
      throw new Error("invalid");
    });
    expect(resolveJournalSource({})).toBeNull();
  });
});
