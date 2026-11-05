// Synthetic research workspace for tests: an in-memory ResearchSourceFs with a flat report (FLAT),
// a report with two revision folders (TWO) and accepted company research for both. No real data.
import { createHash } from "node:crypto";

import { RESEARCH_REPORT_DATASETS } from "@darkfactory/db/schema";

import { type ResearchSourceFs, revisionToken } from "./load.ts";

/** An error shaped like a Node fs "not found" error. */
const missing = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });

export const FIXTURE_ROOT = "/fixture/data";

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

const datasetFiles = (label: string) =>
  new Map(
    RESEARCH_REPORT_DATASETS.map((name) => [
      name,
      encode({ asOf: "2026-01-02T00:00:00Z", label, name }),
    ])
  );

export type ResearchFixture = Readonly<{
  files: Map<string, Uint8Array>;
  fs: ResearchSourceFs;
  tokens: Readonly<{ flat: string; older: string; current: string }>;
  research: Readonly<{ flat: string; two: string; older: string }>;
}>;

const companyResearch = (reportId: string, note: string) => {
  const dossier = { note, reportId };
  return {
    body: encode(dossier),
    revision: createHash("sha256")
      .update(JSON.stringify(dossier))
      .digest("hex"),
  };
};

/** Builds the fixture; `edit` may change or delete files before the fs is created. */
export const researchFixture = (
  edit: (files: Map<string, Uint8Array>) => void = () => undefined
): ResearchFixture => {
  const files = new Map<string, Uint8Array>();
  const flat = datasetFiles("flat");
  const older = datasetFiles("two-older");
  const current = datasetFiles("two-current");
  const tokens = {
    current: revisionToken(current),
    flat: revisionToken(flat),
    older: revisionToken(older),
  };
  for (const [name, bytes] of flat) {
    files.set(`${FIXTURE_ROOT}/${name}.json`, bytes);
  }
  for (const [token, set] of [
    [tokens.older, older],
    [tokens.current, current],
  ] as const) {
    for (const [name, bytes] of set) {
      files.set(
        `${FIXTURE_ROOT}/reports/TWO/revisions/${token}/${name}.json`,
        bytes
      );
    }
  }
  const research = {
    flat: companyResearch("FLAT", "flat accepted"),
    older: companyResearch("TWO", "two superseded"),
    two: companyResearch("TWO", "two accepted"),
  };
  for (const [id, entry] of [
    ["FLAT", research.flat],
    ["TWO", research.older],
    ["TWO", research.two],
  ] as const) {
    files.set(
      `${FIXTURE_ROOT}/company-research/revisions/${entry.revision}/${id}.json`,
      entry.body
    );
  }
  files.set(
    `${FIXTURE_ROOT}/company-research/manifest.json`,
    encode({
      contractVersion: 1,
      reports: {
        FLAT: {
          acceptedAt: "2026-01-03T00:00:00.000Z",
          reportId: "FLAT",
          reportRevision: null,
          revision: research.flat.revision,
        },
        TWO: {
          acceptedAt: "2026-01-04T00:00:00.000Z",
          reportId: "TWO",
          reportRevision: tokens.current,
          revision: research.two.revision,
        },
      },
      schemaVersion: 1,
    })
  );
  files.set(
    `${FIXTURE_ROOT}/reports.json`,
    encode({
      categories: [
        {
          description: "Fixture group",
          id: "fixture",
          label: "Fixture",
          reportIds: ["FLAT", "TWO"],
        },
      ],
      defaultReportId: "FLAT",
      reports: [
        {
          assetType: "equity",
          currency: "USD",
          id: "FLAT",
          identityStatus: "verified",
          name: "Flat Fixture Corp",
          providerSymbol: "FLAT",
          status: "ready",
          symbol: "FLAT",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
        {
          dataRevision: tokens.current,
          id: "TWO",
          identityStatus: "verified",
          name: "Two Fixture Inc",
          providerSymbol: "TWO",
          status: "ready",
          symbol: "TWO",
        },
      ],
      version: 1,
    })
  );
  edit(files);
  const fs: ResearchSourceFs = {
    readDirectory: (path) => {
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          names.add(
            rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest
          );
        }
      }
      return names.size === 0
        ? Promise.reject(missing(path))
        : Promise.resolve([...names]);
    },
    readFile: (path) => {
      const bytes = files.get(path);
      return bytes === undefined
        ? Promise.reject(missing(path))
        : Promise.resolve(bytes);
    },
  };
  return {
    files,
    fs,
    research: {
      flat: research.flat.revision,
      older: research.older.revision,
      two: research.two.revision,
    },
    tokens,
  };
};
