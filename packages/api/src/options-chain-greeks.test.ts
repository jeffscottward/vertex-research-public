import { describe, expect, it } from "vitest";

import {
  blackScholes,
  daysToExpiry,
  expiryCloseMs,
  normalCdf,
  normalPdf,
  yearsToExpiry,
  type BlackScholesInput,
} from "./options-chain-greeks.ts";

const base: BlackScholesInput = {
  right: "call",
  spot: 100,
  strike: 100,
  years: 1,
  volatility: 0.2,
  rate: 0.05,
  dividendYield: 0,
};

describe("normal distribution", () => {
  it("matches table values", () => {
    expect(normalPdf(0)).toBeCloseTo(0.398_942_3, 6);
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.96)).toBeCloseTo(0.975_002_1, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.158_655_3, 6);
    expect(normalCdf(1) + normalCdf(-1)).toBeCloseTo(1, 7);
  });
});

describe("blackScholes", () => {
  // Reference: S=K=100, r=5 %, sigma=20 %, T=1, q=0 (standard textbook values).
  it("prices an at-the-money call and put", () => {
    const call = blackScholes(base);
    const put = blackScholes({ ...base, right: "put" });
    expect(call?.price).toBeCloseTo(10.4506, 3);
    expect(put?.price).toBeCloseTo(5.5735, 3);
    expect(call?.delta).toBeCloseTo(0.6368, 4);
    expect(put?.delta).toBeCloseTo(-0.3632, 4);
    expect(call?.gamma).toBeCloseTo(0.018_762, 5);
    expect(put?.gamma).toBeCloseTo(0.018_762, 5);
    // Vega per 1 vol point; theta per day; rho per 1 rate point.
    expect(call?.vega).toBeCloseTo(0.375_24, 4);
    expect(call?.theta).toBeCloseTo(-6.414 / 365, 5);
    expect(put?.theta).toBeCloseTo(-1.658 / 365, 5);
    expect(call?.rho).toBeCloseTo(0.5323, 3);
    expect(put?.rho).toBeCloseTo(-0.4188, 3);
  });

  // Hull, Options, Futures and Other Derivatives, examples 19.1-19.7:
  // S=49, K=50, r=5 %, sigma=20 %, T=0.3846 years.
  it("matches the Hull worked example", () => {
    const call = blackScholes({
      ...base,
      spot: 49,
      strike: 50,
      years: 0.3846,
    });
    expect(call?.price).toBeCloseTo(2.4, 2);
    expect(call?.delta).toBeCloseTo(0.522, 3);
    expect(call?.gamma).toBeCloseTo(0.066, 3);
    expect((call?.theta ?? 0) * 365).toBeCloseTo(-4.31, 2);
    expect((call?.vega ?? 0) * 100).toBeCloseTo(12.1, 1);
    expect((call?.rho ?? 0) * 100).toBeCloseTo(8.91, 2);
  });

  it("keeps put-call parity with a dividend yield", () => {
    const input = { ...base, dividendYield: 0.03, strike: 110, years: 0.5 };
    const call = blackScholes(input);
    const put = blackScholes({ ...input, right: "put" });
    const parity = 100 * Math.exp(-0.03 * 0.5) - 110 * Math.exp(-0.05 * 0.5);
    expect((call?.price ?? 0) - (put?.price ?? 0)).toBeCloseTo(parity, 6);
    expect((call?.delta ?? 0) - (put?.delta ?? 0)).toBeCloseTo(
      Math.exp(-0.03 * 0.5),
      6
    );
  });

  it("returns null outside the model domain", () => {
    expect(blackScholes({ ...base, volatility: 0 })).toBeNull();
    expect(blackScholes({ ...base, years: -0.1 })).toBeNull();
    expect(blackScholes({ ...base, spot: Number.NaN })).toBeNull();
    expect(blackScholes({ ...base, strike: 0 })).toBeNull();
    expect(
      blackScholes({ ...base, rate: Number.POSITIVE_INFINITY })
    ).toBeNull();
    expect(blackScholes({ ...base, dividendYield: Number.NaN })).toBeNull();
    expect(blackScholes({ ...base, dividendYield: -0.01 })).toBeNull();
  });
});

describe("expiry time", () => {
  it("closes at 16:00 New York in summer and winter", () => {
    expect(new Date(expiryCloseMs("2026-07-17")).toISOString()).toBe(
      "2026-07-17T20:00:00.000Z"
    );
    expect(new Date(expiryCloseMs("2026-12-18")).toISOString()).toBe(
      "2026-12-18T21:00:00.000Z"
    );
  });

  it("follows the US daylight saving switch days", () => {
    const close = (day: string) => new Date(expiryCloseMs(day)).toISOString();
    expect(close("2026-03-06")).toBe("2026-03-06T21:00:00.000Z");
    expect(close("2026-03-08")).toBe("2026-03-08T20:00:00.000Z");
    expect(close("2026-03-13")).toBe("2026-03-13T20:00:00.000Z");
    expect(close("2026-10-30")).toBe("2026-10-30T20:00:00.000Z");
    expect(close("2026-11-01")).toBe("2026-11-01T21:00:00.000Z");
    expect(close("2026-11-06")).toBe("2026-11-06T21:00:00.000Z");
    expect(close("2027-01-15")).toBe("2027-01-15T21:00:00.000Z");
  });

  it("measures years and days to expiry", () => {
    const now = new Date("2026-12-17T21:00:00Z");
    expect(yearsToExpiry("2026-12-18", now)).toBeCloseTo(1 / 365, 9);
    expect(yearsToExpiry("2026-12-17", now)).toBe(0);
    expect(yearsToExpiry("2026-12-16", now)).toBeLessThan(0);
    expect(daysToExpiry("2026-12-18", "2026-11-04")).toBe(44);
    expect(daysToExpiry("2026-11-01", "2026-11-04")).toBe(0);
  });
});
