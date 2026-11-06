import { describe, expect, it } from "vitest";

import { isUiLabEnabled, serverEnvSchema } from "./server.ts";

describe("isUiLabEnabled", () => {
  it.each([
    [{}, false],
    [{ VERTEX_UI_LAB: "on" }, false],
    [{ APP_ENV: "development", VERTEX_UI_LAB: "off" }, false],
    [{ APP_ENV: "development", VERTEX_UI_LAB: "" }, false],
    [{ APP_ENV: "development", VERTEX_UI_LAB: "yes" }, false],
    [{ APP_ENV: "production", VERTEX_UI_LAB: "on" }, false],
    [{ APP_ENV: "staging", VERTEX_UI_LAB: "on" }, false],
    [{ APP_ENV: "development", VERTEX_UI_LAB: "on" }, true],
    [{ APP_ENV: "test", VERTEX_UI_LAB: " ON " }, false],
    [{ APP_ENV: " development", VERTEX_UI_LAB: "on" }, false],
    [{ APP_ENV: "test", VERTEX_UI_LAB: "on" }, true],
  ])("%o -> %s", (source, expected) => {
    expect(isUiLabEnabled(source)).toBe(expected);
  });
});

describe("VERTEX_UI_LAB env schema", () => {
  const field = serverEnvSchema.shape.VERTEX_UI_LAB;

  it("defaults to off and accepts only on or off", () => {
    expect(field.parse(undefined)).toBe("off");
    expect(field.parse("")).toBe("off");
    expect(field.parse("on")).toBe("on");
    expect(field.safeParse("true").success).toBe(false);
  });

  it("rejects on in production and accepts off", () => {
    const production = {
      APP_ENV: "production",
      APP_URL: "https://vertex.example.test",
      BETTER_AUTH_SECRET: "independent-fixture-authentication-key-32",
      BETTER_AUTH_URL: "https://vertex.example.test",
      CONTACT_THROTTLE_SECRET: "independent-fixture-contact-throttle-key-32",
      DATABASE_ALLOWED_HOSTS: "database.pg.psdb.cloud",
      DATABASE_URL:
        "postgresql://database.pg.psdb.cloud:6432/darkfactory_test?sslmode=verify-full",
      EMAIL_PROVIDER: "disabled",
      EMAIL_TRANSPORT: "disabled",
    };
    const on = serverEnvSchema.safeParse({
      ...production,
      VERTEX_UI_LAB: "on",
    });
    expect(on.success).toBe(false);
    expect(on.error?.issues).toContainEqual(
      expect.objectContaining({
        message: "VERTEX_UI_LAB cannot be on in production",
        path: ["VERTEX_UI_LAB"],
      })
    );
    const off = serverEnvSchema.safeParse({
      ...production,
      VERTEX_UI_LAB: "off",
    });
    expect(off.success).toBe(true);
    expect(off.data?.VERTEX_UI_LAB).toBe("off");
  });

  it("allows on in development", () => {
    const development = serverEnvSchema.safeParse({
      APP_ENV: "development",
      DATABASE_URL: "postgresql://127.0.0.1:5432/darkfactory_dev",
      VERTEX_UI_LAB: "on",
    });
    expect(
      development.error?.issues.some(
        (issue) => issue.path[0] === "VERTEX_UI_LAB"
      ) ?? false
    ).toBe(false);
  });
});
