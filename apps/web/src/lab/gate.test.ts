import { describe, expect, it } from "vitest";

import { assertUiLabEnabled, LAB_ROBOTS } from "./gate.ts";

describe("assertUiLabEnabled", () => {
  it.each([
    [{}],
    [{ APP_ENV: "development", VERTEX_UI_LAB: "off" }],
    [{ APP_ENV: "production", VERTEX_UI_LAB: "on" }],
    [{ VERTEX_UI_LAB: "on" }],
  ])("returns 404 for %o", (source) => {
    expect(() => assertUiLabEnabled(source)).toThrow("NEXT_NOT_FOUND");
  });

  it("passes when on in development or test", () => {
    expect(() =>
      assertUiLabEnabled({ APP_ENV: "development", VERTEX_UI_LAB: "on" })
    ).not.toThrow();
    expect(() =>
      assertUiLabEnabled({ APP_ENV: "test", VERTEX_UI_LAB: "on" })
    ).not.toThrow();
  });

  it("reads process.env by default (unit tests leave the lab off)", () => {
    expect(process.env["VERTEX_UI_LAB"]).toBeUndefined();
    expect(() => assertUiLabEnabled()).toThrow("NEXT_NOT_FOUND");
    expect(LAB_ROBOTS).toEqual({ follow: false, index: false });
  });
});
