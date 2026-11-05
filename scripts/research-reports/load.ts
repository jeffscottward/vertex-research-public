// Reads the research dossiers of the old vertex-research workspace (`data/` folder) into one
// ResearchCatalogImport for the Drizzle research reports repository (merge plan P1).
// Layout read: reports.json (catalog), reports/<ID>/revisions/<token>/<dataset>.json, the flat
// <dataset>.json files at the data root (one report without revision folders, APP), and
// company-research/manifest.json with company-research/revisions/<revision>/<ID>.json.
// Every revision token is checked with the workspace rule (revisionFor in
// scripts/reporting/workspace-publication.mjs of the old workspace): SHA-256 over
// "<name>\0<byteLength>\0<bytes>" for the seven datasets in order. Any mismatch stops the import.
// Privacy: `portfolio` files are hashed but never kept as text. Research only; no order path.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  RESEARCH_REPORT_DATASETS,
  type ResearchReportDataset,
} from "@darkfactory/db/schema";
import type {
  ResearchCatalogImport,
  ResearchCompanyResearchInput,
  ResearchDatasetInput,
  ResearchReportInput,
  ResearchRevisionInput,
} from "@darkfactory/db/server";
import { z } from "zod";

/** A source file is missing, unreadable or does not match its token; the CLI exits with code 2. */
export class ResearchSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchSourceError";
  }
}

export type ResearchSourceFs = Readonly<{
  readFile: (path: string) => Promise<Uint8Array>;
  /** Directory entry names; must reject when the path is missing or not a directory. */
  readDirectory: (path: string) => Promise<string[]>;
}>;

export const nodeResearchSourceFs: ResearchSourceFs = {
  readDirectory: async (path) => await readdir(path),
  readFile: async (path) => await readFile(path),
};

const SHA256 = /^[0-9a-f]{64}$/u;

const catalogSchema = z.object({
  categories: z.array(
    z.object({
      description: z.string(),
      id: z.string().min(1).max(80),
      label: z.string().min(1),
      reportIds: z.array(z.string()),
      sourceIds: z.array(z.string()).default([]),
    })
  ),
  reports: z
    .array(
      z.looseObject({
        assetType: z.string().optional(),
        dataRevision: z.string().regex(SHA256).optional(),
        id: z.string().regex(/^[A-Z0-9]{1,10}$/u),
        identityStatus: z.string().min(1),
        name: z.string().min(1),
        providerSymbol: z.string().min(1),
        status: z.string().min(1),
        symbol: z.string().min(1),
        updatedAt: z.iso.datetime({ offset: true }).optional(),
      })
    )
    .min(1),
});

const manifestSchema = z.object({
  reports: z.record(
    z.string(),
    z.object({
      acceptedAt: z.iso.datetime({ offset: true }),
      reportId: z.string(),
      reportRevision: z.string().regex(SHA256).nullable(),
      revision: z.string().regex(SHA256),
    })
  ),
  schemaVersion: z.literal(1),
});

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The workspace revision token over the seven datasets (exact bytes, fixed order). */
export const revisionToken = (
  files: ReadonlyMap<ResearchReportDataset, Uint8Array>
): string => {
  const hash = createHash("sha256");
  for (const name of RESEARCH_REPORT_DATASETS) {
    const bytes = files.get(name);
    if (bytes === undefined) throw new ResearchSourceError(`${name} missing`);
    hash.update(`${name}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** UTF-8 text that parses as JSON; anything else is a source error. */
const jsonText = (bytes: Uint8Array, where: string): string => {
  try {
    const text = utf8.decode(bytes);
    JSON.parse(text);
    return text;
  } catch {
    throw new ResearchSourceError(`${where} is not UTF-8 JSON`);
  }
};

const read = async (
  fs: ResearchSourceFs,
  path: string,
  where: string
): Promise<Uint8Array> => {
  try {
    return await fs.readFile(path);
  } catch {
    throw new ResearchSourceError(`${where}: cannot read ${path}`);
  }
};

const list = async (
  fs: ResearchSourceFs,
  path: string
): Promise<string[] | null> => {
  try {
    return (await fs.readDirectory(path)).sort();
  } catch {
    return null;
  }
};

const parseWith = <S extends z.ZodType>(
  schema: S,
  bytes: Uint8Array,
  where: string
): z.output<S> => {
  const parsed = schema.safeParse(JSON.parse(jsonText(bytes, where)));
  if (parsed.success) return parsed.data;
  throw new ResearchSourceError(
    `${where} is not valid:\n${z.prettifyError(parsed.error)}`
  );
};

/** Reads the seven datasets of one revision folder and checks the token when one is expected. */
const readRevision = async (
  fs: ResearchSourceFs,
  directory: string,
  reportId: string,
  expected: string | null
): Promise<Readonly<{ token: string; datasets: ResearchDatasetInput[] }>> => {
  const files = new Map<ResearchReportDataset, Uint8Array>();
  for (const name of RESEARCH_REPORT_DATASETS) {
    files.set(
      name,
      await read(fs, join(directory, `${name}.json`), `${reportId}/${name}`)
    );
  }
  const token = revisionToken(files);
  if (expected !== null && token !== expected) {
    throw new ResearchSourceError(
      `${reportId}: revision folder ${expected} hashes to ${token}`
    );
  }
  const datasets = [...files].map(([name, bytes]) => ({
    body:
      name === "portfolio"
        ? null
        : jsonText(bytes, `${reportId}/${token}/${name}`),
    byteLength: bytes.length,
    dataset: name,
    sha256: sha256(bytes),
  }));
  return { datasets, token };
};

const readCompanyResearch = async (
  fs: ResearchSourceFs,
  root: string
): Promise<ResearchCompanyResearchInput[]> => {
  const directory = join(root, "company-research", "revisions");
  const revisions = (await list(fs, directory)) ?? [];
  const out: ResearchCompanyResearchInput[] = [];
  for (const revision of revisions) {
    const names = await list(fs, join(directory, revision));
    if (names === null) {
      throw new ResearchSourceError(
        `company-research/${revision}: not a folder`
      );
    }
    for (const file of names) {
      const match = /^([A-Z0-9]{1,10})\.json$/u.exec(file);
      const where = `company-research/${revision}/${file}`;
      if (match?.[1] === undefined || !SHA256.test(revision)) {
        throw new ResearchSourceError(`${where}: unexpected name`);
      }
      const body = jsonText(
        await read(fs, join(directory, revision, file), where),
        where
      );
      // The workspace revision is SHA-256 over JSON.stringify(dossier) (compact form).
      if (sha256(JSON.stringify(JSON.parse(body))) !== revision) {
        throw new ResearchSourceError(`${where}: content does not match`);
      }
      out.push({ body, reportId: match[1], revision });
    }
  }
  return out;
};

export type ResearchSourceSummary = Readonly<{
  reports: number;
  categories: number;
  revisions: number;
  flatRevisions: number;
  datasets: number;
  companyResearch: number;
  acceptedCompanyResearch: number;
}>;

export const summarizeResearchImport = (
  input: ResearchCatalogImport
): ResearchSourceSummary => ({
  acceptedCompanyResearch: input.reports.filter(
    (report) => report.companyResearch !== null
  ).length,
  categories: input.categories.length,
  companyResearch: input.companyResearch.length,
  datasets: input.revisions.reduce(
    (total, revision) => total + revision.datasets.length,
    0
  ),
  flatRevisions: input.revisions.filter(
    (revision) => revision.source === "flat"
  ).length,
  reports: input.reports.length,
  revisions: input.revisions.length,
});

type CatalogEntry = z.output<typeof catalogSchema>["reports"][number];
type ReportRevisions = Readonly<{
  current: string;
  revisions: ResearchRevisionInput[];
}>;

/** All revisions of one report: its revision folders, or the flat data-root files (APP). */
const readReportRevisions = async (
  fs: ResearchSourceFs,
  root: string,
  entry: CatalogEntry,
  flatAllowed: boolean
): Promise<ReportRevisions> => {
  const directory = join(root, "reports", entry.id, "revisions");
  const tokens = await list(fs, directory);
  if (tokens === null) {
    if (!flatAllowed || entry.dataRevision !== undefined) {
      throw new ResearchSourceError(
        `${entry.id}: revision folders are missing`
      );
    }
    const { datasets, token } = await readRevision(fs, root, entry.id, null);
    return {
      current: token,
      revisions: [
        { dataRevision: token, datasets, reportId: entry.id, source: "flat" },
      ],
    };
  }
  const current = entry.dataRevision;
  if (current === undefined || !tokens.includes(current)) {
    throw new ResearchSourceError(
      `${entry.id}: current revision ${current ?? "(none)"} has no folder`
    );
  }
  const revisions: ResearchRevisionInput[] = [];
  for (const token of tokens) {
    const { datasets } = await readRevision(
      fs,
      join(directory, token),
      entry.id,
      token
    );
    revisions.push({
      dataRevision: token,
      datasets,
      reportId: entry.id,
      source: "revision",
    });
  }
  return { current, revisions };
};

/** Reads and verifies the whole workspace data folder. Throws ResearchSourceError on any problem. */
export const loadResearchCatalog = async (
  root: string,
  fs: ResearchSourceFs = nodeResearchSourceFs
): Promise<ResearchCatalogImport> => {
  const catalog = parseWith(
    catalogSchema,
    await read(fs, join(root, "reports.json"), "catalog"),
    "reports.json"
  );
  // Only a missing manifest means "no accepted company research"; any other read error stops.
  const manifestBytes = await fs
    .readFile(join(root, "company-research", "manifest.json"))
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT")
        return null;
      throw new ResearchSourceError("company-research manifest: cannot read");
    });
  const heads: z.output<typeof manifestSchema>["reports"] =
    manifestBytes === null
      ? {}
      : parseWith(manifestSchema, manifestBytes, "company-research manifest")
          .reports;
  const companyResearch = await readCompanyResearch(fs, root);
  const research = new Map(
    companyResearch.map((entry) => [entry.revision, entry.reportId])
  );
  const known = new Set(catalog.reports.map((report) => report.id));
  for (const [key, head] of Object.entries(heads)) {
    if (!known.has(key) || head.reportId !== key) {
      throw new ResearchSourceError(`manifest entry ${key} names no report`);
    }
    if (research.get(head.revision) !== key) {
      throw new ResearchSourceError(
        `${key}: accepted company research ${head.revision} is missing`
      );
    }
  }

  const reports: ResearchReportInput[] = [];
  const revisions: ResearchRevisionInput[] = [];
  for (const entry of catalog.reports) {
    const flatAllowed = !revisions.some((item) => item.source === "flat");
    const found = await readReportRevisions(fs, root, entry, flatAllowed);
    revisions.push(...found.revisions);
    const head = heads[entry.id];
    reports.push({
      assetType: entry.assetType ?? null,
      companyResearch:
        head === undefined
          ? null
          : {
              acceptedAt: new Date(head.acceptedAt),
              reportRevision: head.reportRevision,
              revision: head.revision,
            },
      dataRevision: found.current,
      id: entry.id,
      identityStatus: entry.identityStatus,
      metadata: entry,
      name: entry.name,
      providerSymbol: entry.providerSymbol,
      sourceUpdatedAt:
        entry.updatedAt === undefined ? null : new Date(entry.updatedAt),
      status: entry.status,
      symbol: entry.symbol,
    });
  }
  return {
    categories: catalog.categories,
    companyResearch,
    reports,
    revisions,
  };
};
