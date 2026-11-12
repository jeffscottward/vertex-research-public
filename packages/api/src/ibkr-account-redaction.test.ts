import { describe, expect, it } from "vitest";

import { redactIbkrAccounts } from "./server/ibkr-account-redaction.ts";
import { scrubPortfolioText } from "./server/portfolio-monitor.ts";

// Fake codes only: no real account has these digits.
const CODES = [
  "U0000001",
  "DU0000002",
  "DF0000003",
  "F0000004",
  "I0000005",
  "U0001",
  "DF0002",
] as const;

describe("redactIbkrAccounts", () => {
  it.each(CODES)("replaces %s", (code) => {
    expect(redactIbkrAccounts(`order for ${code}, rejected (${code})`)).toBe(
      "order for [account], rejected ([account])"
    );
  });

  it("replaces every code in one text", () => {
    expect(redactIbkrAccounts(CODES.join(" "))).toBe(
      CODES.map(() => "[account]").join(" ")
    );
  });

  it.each([
    ["three digits", "U001"],
    ["a code inside a longer word", "XU0000001"],
    ["a code followed by letters", "U0000001A"],
    ["lower case", "du0000002"],
    ["another prefix", "Q0000001"],
    ["digits alone", "0000001"],
  ])("keeps %s", (_label, text) => {
    expect(redactIbkrAccounts(text)).toBe(text);
  });

  // The portfolio monitor still has its own copy of the pattern (its file is held by another job).
  // Until it imports this module, this test keeps the two scrubs equal.
  it("removes the same codes as the portfolio monitor scrub", () => {
    const text = `${CODES.join("; ")}; U001; XU0000001; Q0000001`;
    expect(scrubPortfolioText(text, text.length)).toBe(
      redactIbkrAccounts(text)
    );
  });
});
