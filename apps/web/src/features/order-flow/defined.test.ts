import { describe, expect, it } from "vitest";
import { defined } from "./defined.ts";

describe("defined", () => {
  it("returns a present value, including falsy ones", () => {
    expect(defined(0, "zero")).toBe(0);
    expect(defined("", "empty")).toBe("");
  });
  it("throws with the name of what is missing", () => {
    expect(() => defined(undefined, "first trade")).toThrow(
      "Order flow: missing first trade"
    );
  });
});
