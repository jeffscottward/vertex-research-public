import { describe, expect, it } from "vitest";

import { GET, HEAD } from "./route.ts";

describe("missing Academy media route", () => {
  it.each([
    ["GET", GET],
    ["HEAD", HEAD],
  ])(
    "answers %s with a bare uncached 404 and no page render",
    async (_method, handler) => {
      const response = handler();

      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBeNull();
      return expect(await response.text()).toBe("");
    }
  );
});
