import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESEARCH_REPORT_DATASETS } from "@darkfactory/db/schema";
import { describe, expect, it } from "vitest";

import {
  loadResearchCatalog,
  nodeResearchSourceFs,
  ResearchSourceError,
  revisionToken,
  summarizeResearchImport,
} from "./load.ts";
import { FIXTURE_ROOT, researchFixture } from "./test-fixtures.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

const rejects = async (
  edit: (files: Map<string, Uint8Array>) => void,
  message: RegExp
) => {
  const { fs } = researchFixture(edit);
  const error = await loadResearchCatalog(FIXTURE_ROOT, fs).catch(
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ResearchSourceError);
  expect((error as Error).message).toMatch(message);
};

describe("loadResearchCatalog", () => {
  it("reads the catalog, both revision layouts and company research", async () => {
    const { fs, research, tokens } = researchFixture();
    const input = await loadResearchCatalog(FIXTURE_ROOT, fs);
    expect(summarizeResearchImport(input)).toEqual({
      acceptedCompanyResearch: 2,
      categories: 1,
      companyResearch: 3,
      datasets: 21,
      flatRevisions: 1,
      reports: 2,
      revisions: 3,
    });
    const [flat, two] = input.reports;
    expect(flat).toMatchObject({
      assetType: "equity",
      companyResearch: { reportRevision: null, revision: research.flat },
      dataRevision: tokens.flat,
      id: "FLAT",
      sourceUpdatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(flat?.metadata).toMatchObject({ currency: "USD" });
    expect(two).toMatchObject({
      assetType: null,
      companyResearch: {
        acceptedAt: new Date("2026-01-04T00:00:00.000Z"),
        reportRevision: tokens.current,
        revision: research.two,
      },
      dataRevision: tokens.current,
      sourceUpdatedAt: null,
    });
    expect(input.categories).toEqual([
      {
        description: "Fixture group",
        id: "fixture",
        label: "Fixture",
        reportIds: ["FLAT", "TWO"],
        sourceIds: [],
      },
    ]);
    expect(
      input.revisions.map((revision) => [revision.reportId, revision.source])
    ).toEqual([
      ["FLAT", "flat"],
      ["TWO", "revision"],
      ["TWO", "revision"],
    ]);
  });

  it("keeps exact bytes and never keeps portfolio text", async () => {
    const { files, fs, tokens } = researchFixture();
    const input = await loadResearchCatalog(FIXTURE_ROOT, fs);
    const revision = input.revisions.find(
      (item) => item.dataRevision === tokens.current
    );
    const market = revision?.datasets.find((item) => item.dataset === "market");
    const source = files.get(
      `${FIXTURE_ROOT}/reports/TWO/revisions/${tokens.current}/market.json`
    );
    expect(market?.body).toBe(new TextDecoder().decode(source));
    expect(market?.byteLength).toBe(source?.length);
    for (const item of input.revisions) {
      const portfolio = item.datasets.find(
        (entry) => entry.dataset === "portfolio"
      );
      expect(portfolio?.body).toBeNull();
      expect(portfolio?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("stops when a revision folder does not hash to its name", async () => {
    await rejects((files) => {
      const { tokens } = researchFixture();
      files.set(
        `${FIXTURE_ROOT}/reports/TWO/revisions/${tokens.older}/news.json`,
        bytes('{"changed":true}\n')
      );
    }, /hashes to/u);
  });

  it("stops when a dataset file is missing or is not JSON", async () => {
    await rejects((files) => {
      files.delete(`${FIXTURE_ROOT}/technicals.json`);
    }, /FLAT\/technicals: cannot read/u);
    await rejects((files) => {
      files.set(`${FIXTURE_ROOT}/news.json`, bytes("not json"));
    }, /is not UTF-8 JSON/u);
    await rejects((files) => {
      files.set(`${FIXTURE_ROOT}/news.json`, new Uint8Array([0xff, 0xfe]));
    }, /is not UTF-8 JSON/u);
  });

  it("checks the catalog shape", async () => {
    await rejects((files) => {
      files.set(`${FIXTURE_ROOT}/reports.json`, bytes('{"reports":[]}'));
    }, /reports.json is not valid/u);
    await rejects((files) => {
      files.delete(`${FIXTURE_ROOT}/reports.json`);
    }, /catalog: cannot read/u);
  });

  it("needs a folder for the current revision", async () => {
    await rejects((files) => {
      const catalog = JSON.parse(
        new TextDecoder().decode(files.get(`${FIXTURE_ROOT}/reports.json`))
      ) as { reports: Record<string, unknown>[] };
      const two = catalog.reports[1];
      if (two !== undefined) two["dataRevision"] = "0".repeat(64);
      files.set(`${FIXTURE_ROOT}/reports.json`, bytes(JSON.stringify(catalog)));
    }, /current revision 0{64} has no folder/u);
    await rejects((files) => {
      const catalog = JSON.parse(
        new TextDecoder().decode(files.get(`${FIXTURE_ROOT}/reports.json`))
      ) as { reports: Record<string, unknown>[] };
      delete catalog.reports[1]?.["dataRevision"];
      files.set(`${FIXTURE_ROOT}/reports.json`, bytes(JSON.stringify(catalog)));
    }, /current revision \(none\) has no folder/u);
  });

  it("allows one flat report only, and only without a catalog revision", async () => {
    await rejects((files) => {
      for (const key of [...files.keys()]) {
        if (key.includes("/reports/TWO/")) files.delete(key);
      }
    }, /TWO: revision folders are missing/u);
    await rejects((files) => {
      const catalog = JSON.parse(
        new TextDecoder().decode(files.get(`${FIXTURE_ROOT}/reports.json`))
      ) as { reports: Record<string, unknown>[] };
      const flat = catalog.reports[0];
      if (flat !== undefined) flat["dataRevision"] = "1".repeat(64);
      files.set(`${FIXTURE_ROOT}/reports.json`, bytes(JSON.stringify(catalog)));
    }, /FLAT: revision folders are missing/u);
  });

  it("verifies company research names, content and manifest heads", async () => {
    const { research } = researchFixture();
    await rejects((files) => {
      files.set(
        `${FIXTURE_ROOT}/company-research/revisions/${research.flat}/FLAT.json`,
        bytes('{"note":"edited"}')
      );
    }, /content does not match/u);
    await rejects((files) => {
      files.set(
        `${FIXTURE_ROOT}/company-research/revisions/${research.flat}/flat.txt`,
        bytes("{}")
      );
    }, /unexpected name/u);
    await rejects((files) => {
      files.set(
        `${FIXTURE_ROOT}/company-research/revisions/stray.json`,
        bytes("{}")
      );
    }, /company-research\/stray.json: not a folder/u);
    await rejects((files) => {
      files.set(
        `${FIXTURE_ROOT}/company-research/revisions/not-a-hash/FLAT.json`,
        bytes("{}")
      );
    }, /unexpected name/u);
    await rejects((files) => {
      files.delete(
        `${FIXTURE_ROOT}/company-research/revisions/${research.two}/TWO.json`
      );
    }, /TWO: accepted company research [0-9a-f]{64} is missing/u);
    await rejects((files) => {
      const manifest = JSON.parse(
        new TextDecoder().decode(
          files.get(`${FIXTURE_ROOT}/company-research/manifest.json`)
        )
      ) as { reports: Record<string, Record<string, unknown>> };
      const flat = manifest.reports["FLAT"];
      if (flat !== undefined) flat["revision"] = research.two;
      files.set(
        `${FIXTURE_ROOT}/company-research/manifest.json`,
        bytes(JSON.stringify(manifest))
      );
    }, /FLAT: accepted company research [0-9a-f]{64} is missing/u);
    await rejects((files) => {
      const manifest = JSON.parse(
        new TextDecoder().decode(
          files.get(`${FIXTURE_ROOT}/company-research/manifest.json`)
        )
      ) as { reports: Record<string, Record<string, unknown>> };
      manifest.reports["GONE"] = { ...manifest.reports["FLAT"] };
      files.set(
        `${FIXTURE_ROOT}/company-research/manifest.json`,
        bytes(JSON.stringify(manifest))
      );
    }, /manifest entry GONE names no report/u);
    await rejects((files) => {
      const manifest = JSON.parse(
        new TextDecoder().decode(
          files.get(`${FIXTURE_ROOT}/company-research/manifest.json`)
        )
      ) as { reports: Record<string, Record<string, unknown>> };
      const flat = manifest.reports["FLAT"];
      if (flat !== undefined) flat["reportId"] = "TWO";
      files.set(
        `${FIXTURE_ROOT}/company-research/manifest.json`,
        bytes(JSON.stringify(manifest))
      );
    }, /manifest entry FLAT names no report/u);
  });

  it("imports without company research when the folder is absent", async () => {
    const { fs } = researchFixture((files) => {
      for (const key of [...files.keys()]) {
        if (key.includes("/company-research/")) files.delete(key);
      }
    });
    const input = await loadResearchCatalog(FIXTURE_ROOT, fs);
    expect(input.companyResearch).toEqual([]);
    expect(
      input.reports.every((report) => report.companyResearch === null)
    ).toBe(true);
  });

  it("revisionToken needs all seven datasets", () => {
    expect(() => revisionToken(new Map())).toThrow(/market missing/u);
  });

  it("revisionToken matches the workspace revisionFor on a fixed set", () => {
    // Expected value computed once with revisionFor in the old workspace
    // (scripts/reporting/workspace-publication.mjs) for the same seven values.
    const files = new Map(
      RESEARCH_REPORT_DATASETS.map((name) => [
        name,
        bytes(
          `${JSON.stringify({ asOf: "2026-01-02T00:00:00Z", label: "pinned", name }, null, 2)}\n`
        ),
      ])
    );
    expect(revisionToken(files)).toBe(
      "1e2ba8a4ca53a508df88ced955d43cde857142d33c60beafda9887d403031543"
    );
  });

  it("stops when the manifest exists but cannot be read", async () => {
    const { fs } = researchFixture();
    const error = await loadResearchCatalog(FIXTURE_ROOT, {
      readDirectory: fs.readDirectory,
      readFile: (path) =>
        path.endsWith("manifest.json")
          ? Promise.reject(new Error("EACCES"))
          : fs.readFile(path),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResearchSourceError);
    expect((error as Error).message).toMatch(/manifest: cannot read/u);
  });

  it("reads a real folder through the node fs", async () => {
    const { files } = researchFixture();
    const root = await mkdtemp(join(tmpdir(), "research-reports-"));
    try {
      for (const [path, content] of files) {
        const target = join(root, path.slice(FIXTURE_ROOT.length));
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, content);
      }
      const input = await loadResearchCatalog(root, nodeResearchSourceFs);
      expect(input.reports.map((report) => report.id)).toEqual(["FLAT", "TWO"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
