import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as runtime from "@darkfactory/db/server/vertex-research-chat-runtime";
import { describe, expect, it } from "vitest";
import {
  array,
  createPersistenceContext,
  digestString,
  fail,
  identifier,
  insert,
  object,
  one,
  rows,
  string,
  time,
} from "./vertex-persistence-core.ts";
import { createResearchChatCopyLifecycle } from "./vertex-research-chat-copy-lifecycle.ts";
import { createResearchChatDebateOperations } from "./vertex-research-chat-debate-store.ts";
import { createResearchChatExecutionOperations } from "./vertex-research-chat-execution-store.ts";
import {
  createResearchChatNativePhaseStore,
  isNativeEvidencePlan,
  nativeEvidenceCopyKey,
  nativeEvidenceCopyPurposes,
} from "./vertex-research-chat-native-phase-store.ts";
import { createResearchChatOperations } from "./vertex-research-chat-store.ts";
import { createResearchChatWorkerOperations } from "./vertex-research-chat-worker-store.ts";

const packageDirectory = fileURLToPath(new URL("../..", import.meta.url));
const sourceTarget = "./src/server/vertex-research-chat-runtime.ts";
const originalFunctions = {
  createPersistenceContext,
  array,
  digestString,
  fail,
  identifier,
  insert,
  object,
  one,
  rows,
  string,
  time,
  createResearchChatOperations,
  createResearchChatExecutionOperations,
  createResearchChatCopyLifecycle,
  createResearchChatWorkerOperations,
  createResearchChatDebateOperations,
  // Native evidence phase store (f30459c), re-exported by identity.
  createResearchChatNativePhaseStore,
  isNativeEvidencePlan,
  nativeEvidenceCopyKey,
  nativeEvidenceCopyPurposes,
};

// Imports and reference comparisons only: no database, service or factory is started.
describe("research chat runtime package facade", () => {
  it("preserves exact server condition ordering and browser exclusion", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8")
    );
    const entry = manifest.exports["./server/vertex-research-chat-runtime"];
    expect(Object.keys(entry)).toEqual([
      "workerd",
      "worker",
      "browser",
      "import",
      "default",
    ]);
    expect(entry).toEqual({
      browser: "./src/server/unsupported.ts",
      default: sourceTarget,
      import: sourceTarget,
      worker: sourceTarget,
      workerd: sourceTarget,
    });
    return expect(manifest.sideEffects).toContain(
      "./src/server/unsupported.ts"
    );
  });

  it.each([
    [[], "vertex-research-chat-runtime.ts"],
    [["browser"], "unsupported.ts"],
    [["workerd", "browser"], "vertex-research-chat-runtime.ts"],
    [["worker", "browser"], "vertex-research-chat-runtime.ts"],
  ])(
    "resolves conditions %j to %s without loading the target",
    (conditions, target) => {
      const result = spawnSync(
        process.execPath,
        [
          ...conditions.map((condition) => `--conditions=${condition}`),
          "--input-type=module",
          "--eval",
          'process.stdout.write(import.meta.resolve("@darkfactory/db/server/vertex-research-chat-runtime"))',
        ],
        { cwd: packageDirectory, encoding: "utf8", timeout: 10_000 }
      );
      expect({ status: result.status, stderr: result.stderr }).toEqual({
        status: 0,
        stderr: "",
      });
      return expect(result.stdout).toBe(
        new URL(`./${target}`, import.meta.url).href
      );
    }
  );

  it("exports exactly the original and additive runtime functions by identity", () => {
    const runtimeExports: Record<string, unknown> = { ...runtime };
    expect(Object.keys(runtime).sort()).toEqual(
      Object.keys(originalFunctions).sort()
    );
    for (const name of Object.keys(
      originalFunctions
    ) as (keyof typeof originalFunctions)[]) {
      expect(runtimeExports[name]).toBe(originalFunctions[name]);
    }
  });

  return it("keeps the worker output port in DB rather than importing the API owner", async () => {
    const worker = await readFile(
      new URL("./vertex-worker-store.ts", import.meta.url),
      "utf8"
    );
    const port = await readFile(
      new URL("./vertex-research-chat-output-ports.ts", import.meta.url),
      "utf8"
    );
    expect(worker).toContain('from "./vertex-research-chat-output-ports.ts"');
    expect(worker).not.toContain(
      "api/src/server/vertex-research-chat-output-runtime"
    );
    return expect(port).not.toMatch(/from\s+["'][^"']*api(?:\/|["'])/u);
  });
});
