// Read-only reader for the Workspace report store (`data/` of the vertex-research app).
// The merge plan moves these dossiers into PostgreSQL in P1; until then the desk reads the
// accepted report revisions from the Workspace checkout given by `--data-root`. The reader
// never writes there, rejects symbolic links inside the store and checks dataset identity.
import { constants, existsSync, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DeskInput } from "./desk.ts";
import {
  CommitteeDataset,
  FundamentalsDataset,
  NewsDataset,
  type Sentiment,
  SentimentFile,
} from "./research.ts";

const ReportId = z
  .string()
  .max(32)
  .regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/u);
const Catalog = z.looseObject({
  reports: z
    .array(
      z.looseObject({
        assetType: z.string().nullish(),
        currency: z.string().min(1),
        dataRevision: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u)
          .nullish(),
        id: ReportId,
        name: z.string().nullish(),
        providerSymbol: z.string().min(1),
      })
    )
    .min(1)
    .refine(
      (reports) =>
        new Set(reports.map((report) => report.id)).size === reports.length,
      "report IDs must be unique"
    ),
  version: z.literal(1),
});
type CatalogReport = z.infer<typeof Catalog>["reports"][number];

const Identity = z.looseObject({
  currency: z.string().optional(),
  reportId: z.string(),
  security: z
    .looseObject({ currency: z.string(), providerSymbol: z.string() })
    .optional(),
  symbol: z.string().optional(),
});
const Market = z.looseObject({ history: z.array(z.unknown()) });

export class ReportStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReportStoreError";
    this.code = code;
  }
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** Resolves `segments` below the store root; null when absent. Links at any level are refused. */
const safePath = async (
  root: string,
  segments: readonly string[]
): Promise<string | null> => {
  let path = root;
  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    let stat: Stats;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const leaf = index === segments.length - 1;
    if (stat.isSymbolicLink() || !(leaf ? stat.isFile() : stat.isDirectory())) {
      throw new ReportStoreError(
        "UNSAFE_PATH",
        `Report store entry ${segments.slice(0, index + 1).join("/")} is not a plain ${leaf ? "file" : "directory"}`
      );
    }
  }
  return path;
};

const readJsonNoFollow = async (path: string): Promise<unknown> => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
};

const DATASETS = ["market", "fundamentals", "news", "committee"] as const;
type DatasetName = (typeof DATASETS)[number];

const readDataset = async (
  root: string,
  report: CatalogReport,
  name: DatasetName
): Promise<unknown> => {
  const file = `${name}.json`;
  const segments =
    report.id === "APP"
      ? [file]
      : report.dataRevision
        ? ["reports", report.id, "revisions", report.dataRevision, file]
        : ["reports", report.id, file];
  const path = await safePath(root, segments);
  if (path === null) return null;
  const data = await readJsonNoFollow(path);
  if (report.id === "APP") return data;
  const parsed = Identity.safeParse(data);
  const identity = parsed.success ? parsed.data : null;
  const symbolMatches =
    name === "market"
      ? identity?.symbol === report.providerSymbol &&
        identity.currency === report.currency
      : identity?.symbol === undefined ||
        identity.symbol === report.providerSymbol;
  const security = identity?.security;
  const matches =
    identity?.reportId === report.id &&
    symbolMatches &&
    (security === undefined ||
      (security.providerSymbol === report.providerSymbol &&
        security.currency === report.currency));
  if (!matches)
    throw new ReportStoreError(
      "IDENTITY_MISMATCH",
      `${report.id} ${name} dataset identity does not match the catalog`
    );
  return data;
};

const parseDataset = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string
): T | null => {
  if (value === null) return null;
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ReportStoreError(
      "INVALID_DATASET",
      `${label} dataset is not valid`
    );
  return parsed.data;
};

const readSentiment = async (
  sentimentDir: string,
  id: string
): Promise<Sentiment | null> => {
  let value: unknown;
  try {
    value = await readJsonNoFollow(join(sentimentDir, `${id}.json`));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const parsed = SentimentFile.safeParse(value);
  if (!parsed.success)
    throw new ReportStoreError(
      "INVALID_SENTIMENT",
      `${id} sentiment file: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    );
  return parsed.data;
};

/** Reads the catalog (reports.json, else public-catalog.json) and each ticker's datasets. */
export const readDeskInputs = async ({
  dataRoot,
  tickers,
  sentimentDir,
}: Readonly<{
  dataRoot: string;
  tickers: readonly string[];
  sentimentDir: string;
}>): Promise<DeskInput[]> => {
  const root = await realpath(dataRoot);
  const catalogName = existsSync(join(root, "reports.json"))
    ? "reports.json"
    : "public-catalog.json";
  const catalogPath = await safePath(root, [catalogName]);
  if (catalogPath === null)
    throw new ReportStoreError(
      "MISSING_CATALOG",
      `No report catalog in ${dataRoot}`
    );
  const catalog = Catalog.safeParse(await readJsonNoFollow(catalogPath));
  if (!catalog.success)
    throw new ReportStoreError(
      "INVALID_CATALOG",
      `${catalogName} is not a valid version 1 catalog`
    );
  const inputs: DeskInput[] = [];
  for (const id of tickers) {
    const report = catalog.data.reports.find((entry) => entry.id === id);
    if (report === undefined)
      throw new ReportStoreError(
        "UNKNOWN_REPORT",
        `Unknown report ID ${id} in ${catalogName}`
      );
    const [market, fundamentals, news, committee] = await Promise.all(
      DATASETS.map((name) => readDataset(root, report, name))
    );
    inputs.push({
      committee: parseDataset(CommitteeDataset, committee, `${id} committee`),
      fundamentals: parseDataset(
        FundamentalsDataset,
        fundamentals,
        `${id} fundamentals`
      ),
      history: parseDataset(Market, market, `${id} market`)?.history ?? [],
      metadata: {
        assetType: report.assetType ?? null,
        id,
        name: report.name ?? null,
      },
      news: parseDataset(NewsDataset, news, `${id} news`),
      sentiment: await readSentiment(sentimentDir, id),
    });
  }
  return inputs;
};
