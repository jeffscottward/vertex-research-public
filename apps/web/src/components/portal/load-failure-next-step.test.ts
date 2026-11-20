import { describe, expect, it } from "vitest";
import {
  failureNextStep,
  isNotYetCollected,
} from "./load-failure-next-step.ts";

describe("failureNextStep", () => {
  it("offers a retry only when a retry can help", () => {
    expect(failureNextStep({ code: "FORBIDDEN" })).toBe(
      "sign in with an operator account"
    );
    expect(failureNextStep({ code: "UNAUTHORIZED" })).toBe("sign in again");
    expect(
      failureNextStep({
        code: "NOT_FOUND",
        message: "Rotation matrix not yet collected",
      })
    ).toBe("try again after the nightly run");
    expect(
      failureNextStep({
        code: "NOT_FOUND",
        message: "Benchmark ZZZZ: no bars from the market data source",
      })
    ).toBe("change the symbol or benchmark");
    expect(failureNextStep({ code: "NOT_CONFIGURED" })).toBe(
      "ask the operator to configure the research lens endpoint"
    );
    expect(failureNextStep({ code: "STORAGE_ERROR" })).toBeNull();
    expect(failureNextStep({ code: "INTERNAL_SERVER_ERROR" })).toBe(
      "press Try again"
    );
    expect(failureNextStep("boom")).toBe("press Try again");
  });
});

describe("isNotYetCollected", () => {
  it("is true only for a NOT_FOUND with the default or no text", () => {
    expect(isNotYetCollected({ code: "NOT_FOUND" })).toBe(true);
    expect(isNotYetCollected({ code: "NOT_FOUND", message: " " })).toBe(true);
    expect(
      isNotYetCollected({
        code: "NOT_FOUND",
        message: "Sector rotation not yet collected",
      })
    ).toBe(true);
    expect(
      isNotYetCollected({ code: "NOT_FOUND", message: "Benchmark ZZZZ: none" })
    ).toBe(false);
    expect(isNotYetCollected({ code: "STORAGE_ERROR" })).toBe(false);
    expect(isNotYetCollected(null)).toBe(false);
  });
});
