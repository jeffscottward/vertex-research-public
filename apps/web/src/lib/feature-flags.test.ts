import { describe, expect, it } from "vitest";

import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAG_NAMES,
  FEATURE_FLAG_REGISTRY,
  parseFeatureFlagSearchParams,
  parseFeatureFlagTokens,
  resolveFeatureFlagEntries,
  resolveFeatureFlags,
  serializeFeatureFlagOverrides,
} from "./feature-flags.ts";

describe("feature-flag registry", () => {
  it("defaults every registered UI/research flag to off", () => {
    expect(FEATURE_FLAG_NAMES.length).toBeGreaterThanOrEqual(2);
    for (const name of FEATURE_FLAG_NAMES) {
      const def = FEATURE_FLAG_REGISTRY[name];
      expect(def.defaultEnabled).toBe(false);
      expect(["ui", "research"]).toContain(def.area);
      expect(DEFAULT_FEATURE_FLAGS[name]).toBe(false);
    }
  });
});

describe("parseFeatureFlagTokens", () => {
  it("returns empty overrides for empty, nullish, or oversized inputs", () => {
    expect(parseFeatureFlagTokens(undefined)).toEqual({});
    expect(parseFeatureFlagTokens(null)).toEqual({});
    expect(parseFeatureFlagTokens("   ")).toEqual({});
    expect(parseFeatureFlagTokens("a".repeat(2049))).toEqual({});
  });

  it("parses bare names, explicit boolean values, and negated prefixes", () => {
    expect(parseFeatureFlagTokens("ui-experiments-panel")).toEqual({
      "ui-experiments-panel": true,
    });
    expect(
      parseFeatureFlagTokens(
        "ui-experiments-panel=on, research-prototype-slot=off"
      )
    ).toEqual({
      "research-prototype-slot": false,
      "ui-experiments-panel": true,
    });
    expect(
      parseFeatureFlagTokens(
        "ui-experiments-panel=TRUE,research-prototype-slot=0"
      )
    ).toEqual({
      "research-prototype-slot": false,
      "ui-experiments-panel": true,
    });
    expect(
      parseFeatureFlagTokens(
        "ui-experiments-panel=1,research-prototype-slot=false"
      )
    ).toEqual({
      "research-prototype-slot": false,
      "ui-experiments-panel": true,
    });
    expect(
      parseFeatureFlagTokens("-ui-experiments-panel,!research-prototype-slot")
    ).toEqual({
      "research-prototype-slot": false,
      "ui-experiments-panel": false,
    });
    expect(
      parseFeatureFlagTokens(
        "UI-EXPERIMENTS-PANEL=ON, -RESEARCH-PROTOTYPE-SLOT"
      )
    ).toEqual({
      "research-prototype-slot": false,
      "ui-experiments-panel": true,
    });
  });

  it("ignores unknown flags, empty segments, and invalid boolean tokens", () => {
    expect(
      parseFeatureFlagTokens(
        " , nonexistent-flag, -nonexistent-flag, nonexistent-flag=on, ui-experiments-panel=maybe, research-prototype-slot=on , "
      )
    ).toEqual({
      "research-prototype-slot": true,
    });
  });

  it("applies later tokens over earlier tokens", () => {
    expect(
      parseFeatureFlagTokens("ui-experiments-panel=on,-ui-experiments-panel")
    ).toEqual({
      "ui-experiments-panel": false,
    });
  });
});

describe("serializeFeatureFlagOverrides", () => {
  it("serializes overrides in stable registry order", () => {
    expect(serializeFeatureFlagOverrides({})).toBe("");
    expect(
      serializeFeatureFlagOverrides({
        "research-prototype-slot": false,
        "ui-experiments-panel": true,
      })
    ).toBe("research-prototype-slot=off,ui-experiments-panel=on");
  });
});

describe("parseFeatureFlagSearchParams", () => {
  it("merges comma-separated and repeated ff query params", () => {
    expect(
      parseFeatureFlagSearchParams(
        "?theme=dark&ff=ui-experiments-panel&ff=research-prototype-slot=on,-ui-experiments-panel"
      )
    ).toEqual({
      "research-prototype-slot": true,
      "ui-experiments-panel": false,
    });

    const params = new URLSearchParams();
    params.append("ff", "ui-experiments-panel");
    expect(parseFeatureFlagSearchParams(params)).toEqual({
      "ui-experiments-panel": true,
    });
  });
});

describe("resolveFeatureFlags and resolveFeatureFlagEntries", () => {
  it("resolves all flags to default off when called with no inputs", () => {
    expect(resolveFeatureFlags()).toEqual(DEFAULT_FEATURE_FLAGS);
    expect(resolveFeatureFlags({ allowClientOverrides: true })).toEqual(
      DEFAULT_FEATURE_FLAGS
    );
    expect(resolveFeatureFlagEntries()).toEqual([
      {
        enabled: false,
        name: "research-prototype-slot",
        source: "default",
      },
      {
        enabled: false,
        name: "ui-experiments-panel",
        source: "default",
      },
    ]);
  });

  it("ignores localStorage and query overrides when allowClientOverrides is false", () => {
    const entries = resolveFeatureFlagEntries({
      allowClientOverrides: false,
      env: { "ui-experiments-panel": true },
      localStorage: { "research-prototype-slot": true },
      query: {
        "research-prototype-slot": true,
        "ui-experiments-panel": false,
      },
    });
    expect(entries).toEqual([
      {
        enabled: false,
        name: "research-prototype-slot",
        source: "default",
      },
      {
        enabled: true,
        name: "ui-experiments-panel",
        source: "env",
      },
    ]);
  });

  it("applies query > localStorage > env > default when allowClientOverrides is true", () => {
    const entries = resolveFeatureFlagEntries({
      allowClientOverrides: true,
      env: {
        "research-prototype-slot": true,
        "ui-experiments-panel": true,
      },
      localStorage: {
        "research-prototype-slot": false,
        "ui-experiments-panel": false,
      },
      query: {
        "ui-experiments-panel": true,
      },
    });
    expect(entries).toEqual([
      {
        enabled: false,
        name: "research-prototype-slot",
        source: "localStorage",
      },
      {
        enabled: true,
        name: "ui-experiments-panel",
        source: "query",
      },
    ]);
    expect(
      resolveFeatureFlags({
        allowClientOverrides: true,
        env: { "research-prototype-slot": true },
        localStorage: { "research-prototype-slot": false },
        query: { "ui-experiments-panel": true },
      })
    ).toEqual({
      "research-prototype-slot": false,
      "ui-experiments-panel": true,
    });
  });
});
