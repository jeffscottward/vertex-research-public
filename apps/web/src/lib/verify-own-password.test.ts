import { describe, expect, it } from "vitest";

import { verifyOwnPassword } from "./verify-own-password.ts";

const headers = new Headers();

describe("verifyOwnPassword", () => {
  it("returns true only for a status true result", async () => {
    expect(
      await verifyOwnPassword(
        { verifyPassword: async () => ({ status: true }) },
        headers,
        "p"
      )
    ).toBe(true);
    expect(
      await verifyOwnPassword(
        { verifyPassword: async () => null },
        headers,
        "p"
      )
    ).toBe(false);
  });

  it("treats Better Auth's invalid-password error as a wrong password", async () => {
    const api = {
      verifyPassword: async () => {
        throw Object.assign(new Error("Invalid password"), {
          body: { code: "INVALID_PASSWORD" },
        });
      },
    };
    expect(await verifyOwnPassword(api, headers, "p")).toBe(false);
  });

  it.each([
    new Error("database down"),
    Object.assign(new Error("x"), { body: null }),
    Object.assign(new Error("x"), { body: { code: "UNAUTHORIZED" } }),
    "string failure",
  ])("rethrows other errors (%s)", async (failure) => {
    await expect(
      verifyOwnPassword(
        {
          verifyPassword: async () => {
            throw failure;
          },
        },
        headers,
        "p"
      )
    ).rejects.toBe(failure);
  });
});
