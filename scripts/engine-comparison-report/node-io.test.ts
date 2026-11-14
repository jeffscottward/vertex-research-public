import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type ExecFile, nodeReportIo } from "./node-io.ts";

const folders: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true }))
  );
});

describe("nodeReportIo", () => {
  it("writes the page whole, owner-only, and reads files back", async () => {
    const folder = await mkdtemp(join(tmpdir(), "engine-report-"));
    folders.push(folder);
    const io = nodeReportIo({ VERTEX_ORIGIN: "https://vertex.example" });
    const page = join(folder, "out", "index.html");
    expect(await io.exists(page)).toBe(false);
    await io.writeText(page, "<p>one</p>");
    await io.writeText(page, "<p>two</p>");
    expect(await io.exists(page)).toBe(true);
    expect(await io.readText(page)).toBe("<p>two</p>");
    expect((await stat(page)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(folder, "out"))).toEqual(["index.html"]);
    expect(io.env["VERTEX_ORIGIN"]).toBe("https://vertex.example");
    expect(io.now()).toBeInstanceOf(Date);
    expect(io.stdout).toBe(process.stdout);
    expect(io.stderr).toBe(process.stderr);
  });

  it("reads the unit's journal as JSON since the given UTC time", async () => {
    const exec = vi.fn<ExecFile>(async () => ({ stdout: "{}\n" }));
    const io = nodeReportIo({}, exec);
    expect(
      await io.readJournal(
        "vertex-nautilus-worker.service",
        "2026-11-05T06:25:00.000Z"
      )
    ).toBe("{}\n");
    expect(exec).toHaveBeenCalledWith(
      "journalctl",
      [
        "--user",
        "--unit",
        "vertex-nautilus-worker.service",
        "--output",
        "json",
        "--output-fields",
        "MESSAGE",
        "--no-pager",
        "--since",
        "2026-11-05 06:25:00 UTC",
      ],
      { maxBuffer: 512 * 1024 * 1024 }
    );
  });

  it("sends requests with the global fetch", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));
    const response = await nodeReportIo({}).fetch("https://vertex.example/x", {
      method: "POST",
    });
    expect(await response.text()).toBe("ok");
    expect(fetch).toHaveBeenCalledWith("https://vertex.example/x", {
      method: "POST",
    });
  });
});
