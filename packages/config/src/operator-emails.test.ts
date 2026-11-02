import { describe, expect, it } from "vitest";

import {
  isOperatorIdentity,
  parseOperatorEmails,
  serverEnvSchema,
} from "./server.ts";

describe("VERTEX_OPERATOR_EMAILS", () => {
  it("fails closed: absent or blank means no operators", () => {
    expect(parseOperatorEmails(undefined)).toEqual([]);
    expect(parseOperatorEmails("")).toEqual([]);
    return expect(parseOperatorEmails(" , ,")).toEqual([]);
  });

  it("normalizes case and whitespace and removes duplicates", () =>
    expect(
      parseOperatorEmails(
        " Operator@Domain.test, second@domain.test ,OPERATOR@domain.TEST"
      )
    ).toEqual(["operator@domain.test", "second@domain.test"]));

  it("rejects malformed entries and oversized lists", () => {
    expect(
      parseOperatorEmails("operator@domain.test, not-an-email")
    ).toBeNull();
    return expect(
      parseOperatorEmails(
        Array.from(
          { length: 51 },
          (_, index) => `user${index}@domain.test`
        ).join(",")
      )
    ).toBeNull();
  });

  it("is part of the server env schema and rejects invalid lists at parse time", () => {
    const field = serverEnvSchema.shape.VERTEX_OPERATOR_EMAILS;
    expect(field.safeParse(undefined)).toMatchObject({
      success: true,
      data: [],
    });
    expect(field.safeParse("A@Domain.test")).toMatchObject({
      success: true,
      data: ["a@domain.test"],
    });
    return expect(field.safeParse("a@domain.test;b@domain.test").success).toBe(
      false
    );
  });

  return it("isOperatorIdentity: active, verified and listed (case-insensitive)", () => {
    const operator = {
      email: " Operator@Domain.test ",
      emailVerified: true,
      status: "active",
    };
    const list = ["operator@domain.test"];
    expect(isOperatorIdentity(operator, list)).toBe(true);
    expect(isOperatorIdentity(operator, [" OPERATOR@domain.test "])).toBe(true);
    expect(isOperatorIdentity({ ...operator, status: "suspended" }, list)).toBe(
      false
    );
    expect(
      isOperatorIdentity({ ...operator, emailVerified: false }, list)
    ).toBe(false);
    expect(isOperatorIdentity({ ...operator, email: "  " }, list)).toBe(false);
    expect(
      isOperatorIdentity({ ...operator, email: "other@domain.test" }, list)
    ).toBe(false);
    expect(isOperatorIdentity(operator, [])).toBe(false);
    return expect(isOperatorIdentity(operator, undefined)).toBe(false);
  });
});
