import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clientReferenceChunkPath,
  clientReferenceChunkUrlPattern,
} from "./build-chunks.ts";

const PORTAL_SHELL = "src/components/portal-shell.tsx";
const directories: string[] = [];

const clientBuild = async (
  files: Readonly<Record<string, unknown>>
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "build-chunks-"));
  directories.push(directory);
  await mkdir(join(directory, ".vite"));
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(directory, ".vite", name), JSON.stringify(value));
  }
  return directory;
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("clientReferenceChunkPath", () => {
  it("reads the chunk from vinext's client reference map", async () => {
    const directory = await clientBuild({
      "vinext-client-reference-sources.json": {
        [PORTAL_SHELL]: "_next/static/chunks/BJ0IEnad.js",
      },
    });
    expect(clientReferenceChunkPath(PORTAL_SHELL, directory)).toBe(
      "/_next/static/chunks/BJ0IEnad.js"
    );
  });

  it("falls back to the client reference entry of Vite's manifest", async () => {
    const directory = await clientBuild({
      "manifest.json": {
        "_shared.js": { file: "_next/static/chunks/Shared01.js" },
        "virtual:vinext-client-reference-module/c978f93aa3f9/portal-shell": {
          file: "_next/static/chunks/Db5ird7r.js",
          isDynamicEntry: true,
          name: "portal-shell",
        },
      },
    });
    expect(clientReferenceChunkPath(PORTAL_SHELL, directory)).toBe(
      "/_next/static/chunks/Db5ird7r.js"
    );
  });

  it("refuses a build that does not hold the component", async () => {
    const directory = await clientBuild({
      "manifest.json": {},
      "vinext-client-reference-sources.json": {},
    });
    expect(() => clientReferenceChunkPath(PORTAL_SHELL, directory)).toThrow(
      /No client chunk for src\/components\/portal-shell\.tsx/u
    );
  });

  it("refuses two manifest chunks with the component's name", async () => {
    const directory = await clientBuild({
      "manifest.json": {
        "virtual:vinext-client-reference-module/a/portal-shell": {
          file: "_next/static/chunks/One.js",
          name: "portal-shell",
        },
        "virtual:vinext-client-reference-module/b/portal-shell": {
          file: "_next/static/chunks/Two.js",
          name: "portal-shell",
        },
      },
    });
    expect(() => clientReferenceChunkPath(PORTAL_SHELL, directory)).toThrow(
      /Several client reference chunks are named portal-shell/u
    );
  });
});

describe("clientReferenceChunkUrlPattern", () => {
  it("matches that chunk's URL only, with or without a query", async () => {
    const directory = await clientBuild({
      "vinext-client-reference-sources.json": {
        [PORTAL_SHELL]: "_next/static/chunks/A.b-C_d.js",
      },
    });
    const pattern = clientReferenceChunkUrlPattern(PORTAL_SHELL, directory);
    expect(
      pattern.test("https://app.localhost/_next/static/chunks/A.b-C_d.js")
    ).toBe(true);
    expect(pattern.test("/_next/static/chunks/A.b-C_d.js?v=1")).toBe(true);
    expect(pattern.test("/_next/static/chunks/AXb-C_d.js")).toBe(false);
    expect(pattern.test("/_next/static/chunks/A.b-C_d.js.map")).toBe(false);
  });
});
