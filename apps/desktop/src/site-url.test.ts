import { describe, expect, it } from "vitest";

import {
  classifyNavigation,
  parseSiteOrigin,
  resolveSiteOrigin,
} from "./site-url.ts";

describe("parseSiteOrigin", () => {
  it.each([
    [undefined, null],
    ["", null],
    ["   ", null],
    ["not a url", null],
    ["https://vertex.example/dashboard?x=1", "https://vertex.example"],
    [" https://vertex.example:8443/ ", "https://vertex.example:8443"],
    ["http://vertex.example", null],
    ["http://localhost:3000/charts", "http://localhost:3000"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["http://[::1]:3000", "http://[::1]:3000"],
    ["http://vertex.localhost", "http://vertex.localhost"],
    ["https://user:pass@vertex.example", null],
    ["https://user@vertex.example", null],
    ["file:///etc/passwd", null],
    ["javascript:alert(1)", null],
  ])("%j → %j", (raw, expected) => {
    expect(parseSiteOrigin(raw)).toBe(expected);
  });
});

describe("resolveSiteOrigin", () => {
  it("prefers --url, then VERTEX_DESKTOP_URL, then the saved origin", () => {
    const env = { VERTEX_DESKTOP_URL: "https://env.example" };
    expect(
      resolveSiteOrigin({
        argv: ["electron", ".", "--url=https://flag.example/x"],
        env,
        saved: "https://saved.example",
      })
    ).toBe("https://flag.example");
    expect(
      resolveSiteOrigin({ argv: [], env, saved: "https://saved.example" })
    ).toBe("https://env.example");
    expect(
      resolveSiteOrigin({ argv: [], env: {}, saved: "https://saved.example" })
    ).toBe("https://saved.example");
  });

  it("skips invalid candidates and returns null when none is valid", () => {
    expect(
      resolveSiteOrigin({
        argv: ["--url=http://evil.example"],
        env: { VERTEX_DESKTOP_URL: "ftp://x" },
        saved: "https://saved.example",
      })
    ).toBe("https://saved.example");
    expect(resolveSiteOrigin({ argv: [], env: {}, saved: undefined })).toBe(
      null
    );
  });
});

describe("classifyNavigation", () => {
  const origin = "https://vertex.example";
  it.each([
    ["https://vertex.example/charts?symbol=SPY", "inside"],
    ["https://vertex.example:444/charts", "external"],
    ["https://docs.example/page", "external"],
    ["http://vertex.example/charts", "external"],
    ["mailto:a@b.example", "blocked"],
    ["file:///etc/passwd", "blocked"],
    ["javascript:alert(1)", "blocked"],
    ["::not a url", "blocked"],
  ])("%s → %s", (url, expected) => {
    expect(classifyNavigation(origin, url)).toBe(expected);
  });
});
