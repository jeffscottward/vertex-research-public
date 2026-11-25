import { describe, expect, it } from "vitest";

import { areUiFlagClientOverridesAllowed, serverEnvSchema } from "./server.ts";

describe("areUiFlagClientOverridesAllowed", () => {
  it.each([
    [{}, false],
    [{ APP_ENV: "production" }, false],
    [
      { APP_ENV: "production", APP_URL: "https://darkfactory.localhost" },
      false,
    ],
    [{ APP_ENV: "staging" }, false],
    [{ APP_ENV: " development" }, false],
    [{ APP_ENV: "development" }, true],
    [{ APP_ENV: "development", APP_URL: "   " }, true],
    [
      { APP_ENV: "development", APP_URL: "https://darkfactory.localhost" },
      true,
    ],
    [{ APP_ENV: "development", APP_URL: "http://127.0.0.1:3000" }, true],
    [
      { APP_ENV: "development", APP_URL: "https://vertex.example.ts.net:3451" },
      false,
    ],
    [{ APP_ENV: "development", APP_URL: "not-a-url" }, false],
    [{ APP_ENV: "test" }, true],
    [{ APP_ENV: "test", APP_URL: "https://darkfactory.localhost" }, true],
    [{ APP_ENV: "test", APP_URL: "https://darkfactory.example" }, false],
  ])("%o -> %s", (source, expected) => {
    expect(areUiFlagClientOverridesAllowed(source)).toBe(expected);
  });
});

describe("VERTEX_UI_FLAGS env schema", () => {
  const field = serverEnvSchema.shape.VERTEX_UI_FLAGS;

  it("defaults to undefined for missing or blank input", () => {
    expect(field.parse(undefined)).toBeUndefined();
    expect(field.parse("")).toBeUndefined();
    expect(field.parse("   ")).toBeUndefined();
  });

  it.each([
    "ui-experiments-panel",
    "ui-experiments-panel=on, research-prototype-slot=off",
    "ui-experiments-panel=true,research-prototype-slot=false",
    "ui-experiments-panel=1,research-prototype-slot=0",
    "-ui-experiments-panel,!research-prototype-slot",
    "retired-flag=on",
  ])("accepts valid token list %j", (value) => {
    expect(field.parse(value)).toBe(value);
  });

  it.each([
    ",ui-experiments-panel",
    "ui-experiments-panel,",
    "ui-experiments-panel,,research-prototype-slot",
    "ui_experiments_panel",
    "ui-experiments-panel=maybe",
    "ui-experiments-panel=on=off",
    "-ui-experiments-panel=on",
    "bad flag",
  ])("rejects malformed token list %j", (value) => {
    expect(field.safeParse(value).success).toBe(false);
  });

  it("rejects strings longer than 2048 characters", () => {
    const oversized = `a-${"b".repeat(2050)}`;
    expect(field.safeParse(oversized).success).toBe(false);
  });
});
