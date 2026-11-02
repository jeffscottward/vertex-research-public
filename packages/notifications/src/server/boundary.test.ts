import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as publicApi from "../index.ts";

// Authored structural regressions; bundle/declaration integration is a later root gate.
describe("notification entrypoint isolation", () => {
  it("exposes only request/result snapshots from the public runtime entrypoint", () =>
    expect(Object.keys(publicApi).sort()).toEqual([
      "snapshotNotificationRequest",
      "snapshotNotificationResult",
    ]));

  it("rejects server use from browser export conditions", async () => {
    const source = await readFile(
      new URL("../../package.json", import.meta.url),
      "utf8"
    );
    const manifest = JSON.parse(source);
    expect(manifest.exports["./server"].browser).toBe(
      "./src/server/unsupported.ts"
    );
    expect(manifest.sideEffects).toContain("./src/server/unsupported.ts");
    return await expect(import("./unsupported.ts")).rejects.toThrow(
      "unavailable in browser bundles"
    );
  });

  return it("never exports the in-memory fixture from a production entrypoint", async () => {
    const server = await readFile(
      new URL("../server.ts", import.meta.url),
      "utf8"
    );
    expect(server).not.toContain("testing");
    expect(server).not.toContain("memory-store");
    const service = await readFile(
      new URL("./service.ts", import.meta.url),
      "utf8"
    );
    expect(service).not.toContain("createMemoryNotificationFixture");
    return expect(service).not.toContain("process.env");
  });
});
