import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const { lstat: realLstat } =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

import { bars, signalCloses, writeStore } from "./fixtures.test-support.ts";
import { ReportStoreError, readDeskInputs } from "./reports.ts";

let root: string;
let data: string;
const history = bars(signalCloses().slice(0, 30));
const read = (tickers: string[], sentimentDir = join(root, "sentiment")) =>
  readDeskInputs({ dataRoot: data, sentimentDir, tickers });
const write = (path: string, value: unknown) =>
  writeFileSync(
    join(data, path),
    typeof value === "string" ? value : JSON.stringify(value)
  );

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-desk-store-"));
  data = writeStore(root, history);
});
afterEach(() => {
  vi.mocked(lstat).mockImplementation(realLstat);
  rmSync(root, { force: true, recursive: true });
});

describe("readDeskInputs", () => {
  it("reads revision, flat and root report layouts", async () => {
    const [alpha, beta, app] = await read(["AAA", "BBB", "APP"]);
    expect(alpha?.metadata).toEqual({
      assetType: "equity",
      id: "AAA",
      name: "Alpha",
    });
    expect(alpha?.history).toHaveLength(30);
    expect(alpha?.fundamentals?.valuation?.scenarios).toEqual([
      { id: "base", upsidePct: 5 },
    ]);
    expect(alpha?.committee?.finalRecommendation?.status).toBe("wait");
    expect(beta).toMatchObject({
      committee: null,
      fundamentals: null,
      metadata: { assetType: null, name: null },
      news: null,
      sentiment: null,
    });
    expect(beta?.history).toHaveLength(5);
    expect(app?.history).toHaveLength(3);
  });

  it("uses the public catalog when reports.json is absent and treats a missing market as empty", async () => {
    renameSync(join(data, "reports.json"), join(data, "public-catalog.json"));
    unlinkSync(join(data, "reports/BBB/market.json"));
    const [beta] = await read(["BBB"]);
    expect(beta?.history).toEqual([]);
  });

  it("reads and validates supplied sentiment files", async () => {
    const sentimentDir = join(root, "sentiment");
    mkdirSync(sentimentDir);
    writeFileSync(
      join(sentimentDir, "AAA.json"),
      JSON.stringify({
        asOf: "2024-01-05",
        posts: [{ date: "2024-01-05", stance: "bull" }],
        source: "manual",
      })
    );
    expect((await read(["AAA"]))[0]?.sentiment?.posts).toHaveLength(1);
    writeFileSync(
      join(sentimentDir, "AAA.json"),
      JSON.stringify({
        asOf: "2024-01-05",
        posts: [{ date: "2024-01-05", stance: "moon" }],
        source: "manual",
      })
    );
    await expect(read(["AAA"])).rejects.toThrow(/AAA sentiment file: /u);
    unlinkSync(join(sentimentDir, "AAA.json"));
    mkdirSync(join(sentimentDir, "AAA.json"));
    await expect(read(["AAA"])).rejects.toThrow(/EISDIR/u);
    rmSync(join(sentimentDir, "AAA.json"), { recursive: true });
    symlinkSync(join(root, "elsewhere.json"), join(sentimentDir, "AAA.json"));
    await expect(read(["AAA"])).rejects.toThrow(/ELOOP/u);
  });

  it("refuses missing, invalid and unknown catalog entries", async () => {
    await expect(read(["ZZZ"])).rejects.toThrow(
      "Unknown report ID ZZZ in reports.json"
    );
    write("reports.json", { reports: [], version: 1 });
    await expect(read(["AAA"])).rejects.toThrow(
      "reports.json is not a valid version 1 catalog"
    );
    write("reports.json", {
      reports: [
        { currency: "USD", id: "AAA", providerSymbol: "AAA" },
        { currency: "USD", id: "AAA", providerSymbol: "AAA" },
      ],
      version: 1,
    });
    await expect(read(["AAA"])).rejects.toThrow(
      "reports.json is not a valid version 1 catalog"
    );
    unlinkSync(join(data, "reports.json"));
    await expect(read(["AAA"])).rejects.toBeInstanceOf(ReportStoreError);
  });

  it("checks dataset identity and shape", async () => {
    const revision = "reports/AAA/revisions/r1";
    write(`${revision}/news.json`, { reportId: "BBB" });
    await expect(read(["AAA"])).rejects.toThrow(
      "AAA news dataset identity does not match the catalog"
    );
    write(`${revision}/news.json`, { reportId: "AAA", symbol: "OTHER" });
    await expect(read(["AAA"])).rejects.toThrow("identity does not match");
    write(`${revision}/news.json`, "[]");
    await expect(read(["AAA"])).rejects.toThrow("identity does not match");
    write(`${revision}/news.json`, { reportId: "AAA" });
    write(`${revision}/market.json`, {
      currency: "EUR",
      history: [],
      reportId: "AAA",
    });
    await expect(read(["AAA"])).rejects.toThrow(
      "AAA market dataset identity does not match the catalog"
    );
    write(`${revision}/market.json`, {
      currency: "USD",
      history: "none",
      reportId: "AAA",
      symbol: "AAA",
    });
    await expect(read(["AAA"])).rejects.toThrow(
      "AAA market dataset is not valid"
    );
    write(`${revision}/market.json`, {
      currency: "USD",
      history: [],
      reportId: "AAA",
    });
    await expect(read(["AAA"])).rejects.toThrow(
      "AAA market dataset identity does not match the catalog"
    );
    write(`${revision}/market.json`, {
      currency: "USD",
      history: [],
      reportId: "AAA",
      symbol: "AAA",
    });
    write(`${revision}/committee.json`, {
      reportId: "AAA",
      security: { currency: "EUR", providerSymbol: "AAA" },
    });
    await expect(read(["AAA"])).rejects.toThrow(
      "AAA committee dataset identity does not match the catalog"
    );
    write(`${revision}/committee.json`, {
      reportId: "AAA",
      security: { currency: "USD", providerSymbol: "AAA" },
    });
    expect((await read(["AAA"]))[0]?.history).toEqual([]);
  });

  it("refuses symbolic links and unexpected entry types inside the store", async () => {
    const revision = join(data, "reports/AAA/revisions/r1");
    unlinkSync(join(revision, "news.json"));
    symlinkSync(join(revision, "committee.json"), join(revision, "news.json"));
    await expect(read(["AAA"])).rejects.toThrow(
      "reports/AAA/revisions/r1/news.json is not a plain file"
    );
    unlinkSync(join(revision, "news.json"));
    mkdirSync(join(revision, "news.json"));
    await expect(read(["AAA"])).rejects.toThrow("is not a plain file");
    rmSync(join(data, "reports/BBB"), { force: true, recursive: true });
    writeFileSync(join(data, "reports/BBB"), "x");
    await expect(read(["BBB"])).rejects.toThrow(
      "reports/BBB is not a plain directory"
    );
  });

  it("propagates file-system errors other than a missing entry", async () => {
    // Scope the failure to this test's store: an earlier test's Promise.all can
    // leave lstat calls running, and a one-shot mock could be consumed by them.
    const store = realpathSync(data);
    const eio = Object.assign(new Error("EIO: synthetic i/o error"), {
      code: "EIO",
    });
    vi.mocked(lstat).mockImplementation((path) =>
      String(path).startsWith(store) ? Promise.reject(eio) : realLstat(path)
    );
    await expect(read(["AAA"])).rejects.toThrow("EIO: synthetic i/o error");
  });
});
