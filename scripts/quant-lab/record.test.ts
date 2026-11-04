import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as DbServer from "@darkfactory/db/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runQuantLabRecord } from "./record.ts";
import {
  captureFixture,
  rawResultFixture,
  specFixture,
} from "./test-fixtures.ts";

const fakes = vi.hoisted(() => {
  const close = vi.fn(async () => undefined);
  const store = {
    advancePaperStage: vi.fn(async () => undefined),
    ensureBacktest: vi.fn(async () => undefined),
    ensureCapture: vi.fn(async () => "capture-stored"),
    ensurePaper: vi.fn(async () => "paper-stored"),
    ensureSpec: vi.fn(async () => undefined),
    ensureTask: vi.fn(async () => undefined),
    findCaptureId: vi.fn(async (): Promise<string | null> => null),
    findPaperId: vi.fn(async (): Promise<string | null> => null),
    setPaperOutcome: vi.fn(async () => undefined),
    upsertStrategy: vi.fn(async () => "strategy-stored"),
  };
  return {
    close,
    createNodeDatabase: vi.fn(() => ({ close, db: { fake: true } })),
    recordQuantLab: vi.fn(
      async (_db: unknown, work: (s: typeof store) => Promise<unknown>) =>
        work(store)
    ),
    store,
  };
});

vi.mock("@darkfactory/db/server", async (importOriginal) => {
  const actual = await importOriginal<typeof DbServer>();
  return {
    createNodeDatabase: fakes.createNodeDatabase,
    normalizeBacktestResult: actual.normalizeBacktestResult,
    recordQuantLab: fakes.recordQuantLab,
  };
});

let directory = "";
let out: string[] = [];
let err: string[] = [];

const write = (name: string, value: unknown) => {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};

const runScript = (
  args: string[],
  env: Record<string, string> = { DATABASE_URL: "postgresql://test" }
) =>
  runQuantLabRecord(args, {
    env,
    stderr: { write: (text: string) => err.push(text) > 0 },
    stdout: { write: (text: string) => out.push(text) > 0 },
  });

const json = () => JSON.parse(out.join("")) as Record<string, unknown>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "quant-lab-record-"));
  out = [];
  err = [];
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe("runQuantLabRecord", () => {
  it("prints paper, capture, strategy, spec and backtest rows on a dry run", async () => {
    const code = await runScript([
      "--capture",
      write("capture.json", captureFixture),
      "--spec",
      write("spec.json", specFixture),
      "--result",
      write("result.json", rawResultFixture),
      "--dry-run",
    ]);
    expect(code).toBe(0);
    const rows = json();
    expect(rows).toMatchObject({
      backtest: { drawdown: "…", equity: "…", paperId: null, trades: "…" },
      captures: [{ id: "capture-bafbf505c9e4c0a2" }],
      papers: [{ id: "paper-ssrn-2242795" }],
      spec: { id: "spec-7eb540a22b926076", paperId: null },
      strategy: { status: "backtested" },
    });
    expect(fakes.createNodeDatabase).not.toHaveBeenCalled();
  });

  it("prints a researching strategy and no backtest for a spec alone", async () => {
    expect(
      await runScript(["--spec", write("spec.json", specFixture), "--dry-run"])
    ).toBe(0);
    expect(json()).toMatchObject({
      backtest: null,
      captures: [],
      papers: [],
      strategy: { status: "researching" },
    });
  });

  it("prints only paper rows for a search file", async () => {
    const search = write("search.json", {
      captured_at: "x",
      captures: [captureFixture],
    });
    expect(await runScript(["--search", search, "--dry-run"])).toBe(0);
    expect(json()).toMatchObject({
      backtest: null,
      spec: null,
      strategy: null,
    });
  });

  it("reports an empty search without writing", async () => {
    const search = write("search.json", { captures: [] });
    expect(await runScript(["--search", search])).toBe(0);
    expect(json()).toEqual({ note: "search returned no captures", papers: 0 });
    expect(fakes.recordQuantLab).not.toHaveBeenCalled();
  });

  it("rejects missing or inconsistent inputs with exit code 2", async () => {
    expect(await runScript([])).toBe(2);
    expect(
      await runScript([
        "--capture",
        write("capture.json", captureFixture),
        "--result",
        write("result.json", rawResultFixture),
      ])
    ).toBe(2);
    expect(
      await runScript([
        "--spec",
        write("spec.json", { ...specFixture, spec_sha256: "c".repeat(64) }),
        "--result",
        write("result.json", rawResultFixture),
      ])
    ).toBe(2);
    expect(
      await runScript([
        "--capture",
        write("capture.json", { ...captureFixture, doi: "10.2139/ssrn.1" }),
        "--spec",
        write("spec.json", specFixture),
      ])
    ).toBe(2);
    expect(
      await runScript(["--capture", write("capture.json", captureFixture)], {})
    ).toBe(2);
    expect(err).toEqual([
      "pass --capture, --search and/or --spec [--result]\n",
      "--result needs the --spec it was produced from (spec_sha256 mismatch)\n",
      "--result needs the --spec it was produced from (spec_sha256 mismatch)\n",
      "--spec belongs to a different paper than --capture\n",
      "DATABASE_URL is required (or pass --dry-run)\n",
    ]);
  });

  it("fails with exit code 1 on unreadable files or a database error", async () => {
    expect(await runScript(["--capture", join(directory, "none.json")])).toBe(
      1
    );
    expect(err[0]).toMatch(/^quant lab record failed: ENOENT/);
    const broken = join(directory, "broken.json");
    writeFileSync(broken, "{");
    expect(await runScript(["--capture", broken])).toBe(1);
    fakes.recordQuantLab.mockRejectedValueOnce("boom");
    expect(
      await runScript(["--capture", write("capture.json", captureFixture)])
    ).toBe(1);
    expect(err[2]).toBe("quant lab record failed: boom\n");
    expect(fakes.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["--capture", { ...captureFixture, doi: 1 }],
    ["--capture", { ...captureFixture, doi: "10.1000/other" }],
    ["--capture", { ...captureFixture, captured_at: "2026-10-18" }],
    ["--capture", { ...captureFixture, pdf_status: "unknown" }],
    ["--search", { captures: [{ ...captureFixture, pdf_status: "" }] }],
    ["--spec", { ...specFixture, paper_claims: [] }],
    ["--spec", { ...specFixture, our_reading: ["not", "an", "object"] }],
    ["--result", { ...rawResultFixture, verdict: "great" }],
  ])("rejects an invalid %s file with exit code 2", async (flag, value) => {
    expect(await runScript([flag, write("input.json", value)])).toBe(2);
    expect(err[0]).toContain(
      `${flag} ${join(directory, "input.json")} is not valid:`
    );
    expect(fakes.createNodeDatabase).not.toHaveBeenCalled();
  });

  it("writes every record in one recording and closes the database", async () => {
    const code = await runScript([
      "--capture",
      write("capture.json", captureFixture),
      "--spec",
      write("spec.json", specFixture),
      "--result",
      write("result.json", rawResultFixture),
    ]);
    expect(code).toBe(0);
    expect(json()).toMatchObject({
      papers: 1,
      spec: "spec-7eb540a22b926076",
      strategy: "strategy-stored",
      verdict: "inconclusive",
    });
    expect(fakes.createNodeDatabase).toHaveBeenCalledWith({
      connectionString: "postgresql://test",
    });
    expect(fakes.store.ensureSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        captureId: "capture-stored",
        paperId: "paper-stored",
        strategyId: "strategy-stored",
      })
    );
    expect(fakes.store.advancePaperStage).toHaveBeenCalledWith(
      "paper-stored",
      "spec_extracted",
      ["queued", "ingested"]
    );
    expect(fakes.store.ensureTask).toHaveBeenCalledWith(
      expect.objectContaining({ paperId: "paper-stored", status: "succeeded" })
    );
    expect(fakes.store.ensureBacktest).toHaveBeenCalledOnce();
    expect(fakes.store.setPaperOutcome).toHaveBeenCalledWith(
      "paper-stored",
      expect.objectContaining({ verdict: "inconclusive" })
    );
    expect(fakes.store.findPaperId).not.toHaveBeenCalled();
    expect(fakes.close).toHaveBeenCalledOnce();
  });

  it("links a spec to a paper and capture recorded earlier", async () => {
    fakes.store.findPaperId.mockResolvedValueOnce("paper-earlier");
    fakes.store.findCaptureId.mockResolvedValueOnce("capture-earlier");
    expect(await runScript(["--spec", write("spec.json", specFixture)])).toBe(
      0
    );
    expect(json()).toEqual({
      papers: 0,
      spec: "spec-7eb540a22b926076",
      strategy: "strategy-stored",
    });
    expect(fakes.store.findPaperId).toHaveBeenCalledWith(specFixture.paper.doi);
    expect(fakes.store.findCaptureId).toHaveBeenCalledWith(
      specFixture.paper.doi,
      specFixture.paper.version
    );
    expect(fakes.store.ensureSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        captureId: "capture-earlier",
        paperId: "paper-earlier",
      })
    );
    expect(fakes.store.advancePaperStage).toHaveBeenCalledWith(
      "paper-earlier",
      "spec_extracted",
      ["queued", "ingested"]
    );
  });

  it("looks up the capture of the spec's version when this run captured another version", async () => {
    expect(
      await runScript([
        "--capture",
        write("capture.json", { ...captureFixture, version: "v-other" }),
        "--spec",
        write("spec.json", specFixture),
      ])
    ).toBe(0);
    expect(fakes.store.findPaperId).not.toHaveBeenCalled();
    expect(fakes.store.findCaptureId).toHaveBeenCalledWith(
      specFixture.paper.doi,
      specFixture.paper.version
    );
    expect(fakes.store.ensureSpec).toHaveBeenCalledWith(
      expect.objectContaining({ captureId: null, paperId: "paper-stored" })
    );
  });

  it("rejects a spec whose paper is not recorded with exit code 2", async () => {
    expect(
      await runScript([
        "--spec",
        write("spec.json", specFixture),
        "--result",
        write("result.json", rawResultFixture),
      ])
    ).toBe(2);
    expect(err).toEqual([
      `--spec paper ${specFixture.paper.doi} is not recorded; pass its --capture (or record it first)\n`,
    ]);
    expect(fakes.store.ensureSpec).not.toHaveBeenCalled();
    expect(fakes.store.ensureBacktest).not.toHaveBeenCalled();
    expect(fakes.close).toHaveBeenCalledOnce();
  });

  it("records only papers and captures without a spec", async () => {
    expect(
      await runScript(["--capture", write("capture.json", captureFixture)])
    ).toBe(0);
    expect(json()).toEqual({ papers: 1 });
    expect(fakes.store.upsertStrategy).not.toHaveBeenCalled();
  });
});
