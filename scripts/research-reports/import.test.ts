import {
  type ResearchCatalogImport,
  type ResearchImportResult,
  ResearchReportsInputError,
  type ResearchReportsRepository,
} from "@darkfactory/db/server";
import { describe, expect, it, vi } from "vitest";

import { runResearchReportsImport } from "./import.ts";
import { FIXTURE_ROOT, researchFixture } from "./test-fixtures.ts";

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    err,
    io: (env: NodeJS.ProcessEnv = {}) => ({
      env,
      stderr: { write: (chunk: string) => err.push(chunk) > 0 },
      stdout: { write: (chunk: string) => out.push(chunk) > 0 },
    }),
    out,
  };
};

const result: ResearchImportResult = {
  companyResearchAdded: 3,
  counts: {
    acceptedCompanyResearch: 2,
    categories: 1,
    companyResearch: 3,
    datasets: 21,
    privateDatasets: 3,
    reports: 2,
    revisions: 3,
  },
  datasetsAdded: 21,
  reportsRemoved: 0,
  revisionsAdded: 3,
};

const repositoryWith = (
  replaceCatalog: ResearchReportsRepository["replaceCatalog"]
): ResearchReportsRepository => ({
  counts: vi.fn(),
  getCompanyResearch: vi.fn(),
  getDataset: vi.fn(),
  getReport: vi.fn(),
  listCatalog: vi.fn(),
  listRevisions: vi.fn(),
  replaceCatalog,
});

describe("runResearchReportsImport", () => {
  it("prints usage without --data-root", async () => {
    const { err, io } = capture();
    expect(await runResearchReportsImport([], io())).toBe(2);
    expect(await runResearchReportsImport(["--data-root"], io())).toBe(2);
    expect(
      await runResearchReportsImport(["--data-root", "--dry-run"], io())
    ).toBe(2);
    expect(err.join("")).toMatch(/usage: bun run vertex:research-reports/u);
  });

  it("needs DATABASE_URL unless --dry-run", async () => {
    const { err, io } = capture();
    expect(
      await runResearchReportsImport(["--data-root", FIXTURE_ROOT], io())
    ).toBe(2);
    expect(
      await runResearchReportsImport(
        ["--data-root", FIXTURE_ROOT],
        io({ DATABASE_URL: "" })
      )
    ).toBe(2);
    expect(err.join("")).toMatch(/DATABASE_URL is required/u);
  });

  it("prints source counts on --dry-run without opening a database", async () => {
    const { fs } = researchFixture();
    const { io, out } = capture();
    const openRepository = vi.fn();
    expect(
      await runResearchReportsImport(
        ["--data-root", FIXTURE_ROOT, "--dry-run"],
        io({ DATABASE_URL: "postgres://unused" }),
        { fs, openRepository }
      )
    ).toBe(0);
    expect(openRepository).not.toHaveBeenCalled();
    expect(JSON.parse(out.join(""))).toMatchObject({
      dryRun: true,
      source: { datasets: 21, reports: 2, revisions: 3 },
    });
  });

  it("writes through the repository and closes the connection", async () => {
    const { fs } = researchFixture();
    const { io, out } = capture();
    const close = vi.fn(() => Promise.resolve());
    const replaceCatalog = vi.fn(
      (_input: ResearchCatalogImport, _options?: { allowRemoval?: boolean }) =>
        Promise.resolve(result)
    );
    expect(
      await runResearchReportsImport(
        ["--data-root", FIXTURE_ROOT],
        io({ DATABASE_URL: "postgres://db" }),
        {
          fs,
          openRepository: (url) => {
            expect(url).toBe("postgres://db");
            return { close, repository: repositoryWith(replaceCatalog) };
          },
        }
      )
    ).toBe(0);
    expect(replaceCatalog).toHaveBeenCalledOnce();
    expect(replaceCatalog.mock.calls[0]?.[1]).toEqual({ allowRemoval: false });
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(out.join(""))).toMatchObject({
      result: { revisionsAdded: 3 },
      source: { companyResearch: 3 },
    });
    await runResearchReportsImport(
      ["--data-root", FIXTURE_ROOT, "--allow-remove"],
      io({ DATABASE_URL: "postgres://db" }),
      {
        fs,
        openRepository: () => ({
          close,
          repository: repositoryWith(replaceCatalog),
        }),
      }
    );
    expect(replaceCatalog.mock.calls[1]?.[1]).toEqual({ allowRemoval: true });
  });

  it("exits 2 on a source or input error and 1 on other failures", async () => {
    const broken = researchFixture((files) => {
      files.delete(`${FIXTURE_ROOT}/reports.json`);
    });
    const first = capture();
    expect(
      await runResearchReportsImport(
        ["--data-root", FIXTURE_ROOT, "--dry-run"],
        first.io(),
        { fs: broken.fs }
      )
    ).toBe(2);
    expect(first.err.join("")).toMatch(/catalog: cannot read/u);

    const { fs } = researchFixture();
    const close = vi.fn(() => Promise.resolve());
    const run = (error: unknown) => {
      const io = capture();
      return runResearchReportsImport(
        ["--data-root", FIXTURE_ROOT],
        io.io({ DATABASE_URL: "postgres://db" }),
        {
          fs,
          openRepository: () => ({
            close,
            repository: repositoryWith(() => Promise.reject(error)),
          }),
        }
      ).then((code) => ({ code, err: io.err.join("") }));
    };
    expect(await run(new ResearchReportsInputError("bad input"))).toEqual({
      code: 2,
      err: "bad input\n",
    });
    expect(await run(new Error("connection refused"))).toEqual({
      code: 1,
      err: "research report import failed: connection refused\n",
    });
    expect(await run("plain")).toEqual({
      code: 1,
      err: "research report import failed: plain\n",
    });
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("opens a node database by default and reports a connection failure", async () => {
    const { fs } = researchFixture();
    const { err, io } = capture();
    expect(
      await runResearchReportsImport(
        ["--data-root", FIXTURE_ROOT],
        io({ DATABASE_URL: "postgres://nobody:none@127.0.0.1:1/none" }),
        { fs }
      )
    ).toBe(1);
    expect(err.join("")).toMatch(/research report import failed/u);
  });
});
