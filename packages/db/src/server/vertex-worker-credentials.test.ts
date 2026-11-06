import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client.ts";
import type { VertexScope } from "./vertex-ports.ts";
import { createVertexWorkerCredentials } from "./vertex-worker-credentials.ts";

const scope: VertexScope = {
  accountAlias: "synthetic-paper",
  environment: "paper",
};

describe("worker credential transaction errors", () => {
  it.each([
    ["direct unique violation", { code: "23505" }, "conflict"],
    ["wrapped serialization failure", { cause: { code: "40001" } }, "conflict"],
    [
      "doubly wrapped deadlock",
      { cause: { cause: { code: "40P01" } } },
      "conflict",
    ],
    ["wrapped other driver code", { cause: { code: "57P01" } }, "unavailable"],
    ["error without a code", new Error("socket closed"), "unavailable"],
  ] as const)("maps a %s to %s", async (_kind, error, code) => {
    // The database rejects the whole transaction; the operation body never runs.
    const credentials = createVertexWorkerCredentials(
      {
        transaction: vi.fn(async () => Promise.reject(error)),
      } as unknown as Database,
      {
        capture: <T>(value: T): T => structuredClone(value),
        hash: vi.fn(async () => "a".repeat(64)),
        now: () => "2026-09-22T12:00:01.000000001Z",
      },
      {
        authorizeGrantAdministration: vi.fn(async () => false),
        validateWorker: vi.fn(),
      }
    );
    await expect(
      credentials.transaction(scope, async () => "unused")
    ).rejects.toMatchObject({ code, name: "VertexStoreError" });
  });
});
