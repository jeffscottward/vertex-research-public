import { afterEach, describe, expect, it, vi } from "vitest";
import {
  failureBody,
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
    expect(failureNextStep({ code: "BAD_REQUEST" })).toBe("change the request");
    expect(failureNextStep({ code: "STORAGE_ERROR" })).toBeNull();
    expect(failureNextStep({ code: "INTERNAL_SERVER_ERROR" })).toBe(
      "press Try again"
    );
    expect(failureNextStep("boom")).toBe("press Try again");
  });

  it("adds no step when the message already names its retry", () => {
    expect(
      failureNextStep({
        code: "UNAVAILABLE",
        message: "Request failed at 14:05 UTC. Nothing was changed. Try again.",
      })
    ).toBeNull();
    expect(
      failureNextStep({
        code: "UNAVAILABLE",
        message: "Market data source request failed; retry",
      })
    ).toBeNull();
  });

  it("uses the lens's own step for any NOT_FOUND", () => {
    expect(
      failureNextStep(
        { code: "NOT_FOUND", message: "rotation document returned HTTP 404" },
        { notFound: "try again after the nightly run" }
      )
    ).toBe("try again after the nightly run");
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

describe("failureBody", () => {
  const failedAt = Date.parse("2026-11-19T15:00:30.000Z");
  afterEach(() => {
    vi.useRealTimers();
  });

  it("joins the message, the time of the failure and the next step", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-19T15:10:00.000Z"));
    expect(
      failureBody("Matrix read failed.", failedAt, "press Try again")
    ).toBe("Matrix read failed · 15:00 UTC · press Try again");
    expect(failureBody("Storage is not configured", failedAt, null)).toBe(
      "Storage is not configured · 15:00 UTC"
    );
  });

  it("leaves the failure time out when the message already holds a time", () => {
    expect(
      failureBody(
        "Rotation matrix request timed out at 14:05 UTC. Nothing was changed. Try again.",
        failedAt,
        null
      )
    ).toBe(
      "Rotation matrix request timed out at 14:05 UTC. Nothing was changed. Try again"
    );
  });
});
