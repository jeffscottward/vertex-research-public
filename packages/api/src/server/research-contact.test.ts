import { afterEach, describe, expect, it } from "vitest";
import {
  researchUserAgent,
  setResearchContactEmail,
} from "./research-contact.ts";

describe("researchUserAgent", () => {
  afterEach(() => setResearchContactEmail(undefined));

  it("uses the placeholder contact when none is configured", () => {
    expect(researchUserAgent("deep-value")).toBe(
      "vertex-research deep-value (personal research; owner@example.com)"
    );
  });

  it("uses the configured contact and falls back on blank values", () => {
    setResearchContactEmail(" research@contact.test ");
    expect(researchUserAgent("congress-trades")).toBe(
      "vertex-research congress-trades (personal research; research@contact.test)"
    );
    setResearchContactEmail("  ");
    expect(researchUserAgent("x")).toContain("owner@example.com");
  });
});
