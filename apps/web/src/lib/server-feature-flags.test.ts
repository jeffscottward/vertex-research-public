import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_FEATURE_FLAGS } from "./feature-flags.ts";
import {
  getServerFeatureFlagSnapshot,
  isServerFeatureFlagEnabled,
} from "./server-feature-flags.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("server feature flags", () => {
  it("defaults all flags off and disables client overrides when env is empty", () => {
    const snapshot = getServerFeatureFlagSnapshot({});
    expect(snapshot).toEqual({
      allowClientOverrides: false,
      envOverrides: {},
      flags: DEFAULT_FEATURE_FLAGS,
    });
  });

  it("enables flags from VERTEX_UI_FLAGS and gates client overrides by APP_ENV and local APP_URL", () => {
    const dev = getServerFeatureFlagSnapshot({
      APP_ENV: "development",
      APP_URL: "https://darkfactory.localhost",
      VERTEX_UI_FLAGS: "ui-experiments-panel=on",
    });
    expect(dev.allowClientOverrides).toBe(true);
    expect(dev.envOverrides).toEqual({ "ui-experiments-panel": true });
    expect(dev.flags).toEqual({
      "research-prototype-slot": false,
      "ui-experiments-panel": true,
    });

    const deployedDev = getServerFeatureFlagSnapshot({
      APP_ENV: "development",
      APP_URL: "https://vertex.example.ts.net:3451",
      VERTEX_UI_FLAGS: "ui-experiments-panel=on",
    });
    expect(deployedDev.allowClientOverrides).toBe(false);
    expect(deployedDev.flags["ui-experiments-panel"]).toBe(true);

    const prod = getServerFeatureFlagSnapshot({
      APP_ENV: "production",
      VERTEX_UI_FLAGS: "research-prototype-slot",
    });
    expect(prod.allowClientOverrides).toBe(false);
    expect(prod.flags).toEqual({
      "research-prototype-slot": true,
      "ui-experiments-panel": false,
    });
  });

  it("reads process.env by default and accepts explicit source in isServerFeatureFlagEnabled", () => {
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("VERTEX_UI_FLAGS", "ui-experiments-panel");
    expect(isServerFeatureFlagEnabled("ui-experiments-panel")).toBe(true);
    expect(isServerFeatureFlagEnabled("research-prototype-slot")).toBe(false);
    expect(
      isServerFeatureFlagEnabled("research-prototype-slot", {
        VERTEX_UI_FLAGS: "research-prototype-slot=on",
      })
    ).toBe(true);
  });
});
