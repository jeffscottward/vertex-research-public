import { describe, expect, it } from "vitest";
import {
  CANONICAL_APP_URL,
  type ClientEnv,
  type ClientEnvironmentSource,
  isDevelopmentLocalhostHttpOrigin,
  toClientEnv,
} from "./client.ts";

describe("client environment contract", () => {
  it("returns only the public environment allowlist", () => {
    const source: ClientEnvironmentSource = {
      APP_ENV: "test",
      APP_URL: CANONICAL_APP_URL,
      APP_NAME: "Vertex Research",
    };
    const clientEnv: ClientEnv = toClientEnv(source);

    expect(clientEnv).toEqual(source);
    expect(clientEnv.APP_URL).toBe("https://darkfactory.localhost");
    return expect(Object.keys(clientEnv)).toEqual([
      "APP_ENV",
      "APP_URL",
      "APP_NAME",
    ]);
  });

  return it("returns a new immutable-shaped value instead of the source object", () => {
    const source: ClientEnvironmentSource = {
      APP_ENV: "development",
      APP_URL: CANONICAL_APP_URL,
      APP_NAME: "Vertex Research",
    };

    return expect(toClientEnv(source)).not.toBe(source);
  });
});

describe("isDevelopmentLocalhostHttpOrigin", () => {
  it("accepts a portless http *.localhost origin only in development", () => {
    expect(
      isDevelopmentLocalhostHttpOrigin("http://vertex.localhost", "development")
    ).toBe(true);
    return expect(
      isDevelopmentLocalhostHttpOrigin(
        new URL("http://vertex.localhost"),
        "development"
      )
    ).toBe(true);
  });

  it("rejects the same origin outside development", () => {
    for (const environment of ["test", "production", undefined, ""]) {
      expect(
        isDevelopmentLocalhostHttpOrigin("http://vertex.localhost", environment)
      ).toBe(false);
    }
  });

  it("rejects non-localhost, ported, credentialed, https and malformed values", () => {
    for (const value of [
      "http://vertex.example",
      "http://localhost",
      "http://vertex.localhost:8080",
      "http://user:pass@vertex.localhost",
      "https://vertex.localhost",
      "not a URL",
    ]) {
      expect(isDevelopmentLocalhostHttpOrigin(value, "development")).toBe(
        false
      );
    }
  });
});
