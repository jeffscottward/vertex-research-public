import { readFileSync } from "node:fs";

import { InvalidRepositoryInputError } from "@darkfactory/db/server";
import { describe, expect, it, vi } from "vitest";

import {
  type CliIo,
  type OpenResearchStudyStore,
  openResearchStudyStore,
  parseStudyDocuments,
  RESEARCH_STUDIES_IMPORT_USAGE,
  RESEARCH_STUDY_BATCH_MAX,
  RESEARCH_STUDY_INPUT_MAX_BYTES,
  type ResearchStudyStore,
  runResearchStudiesImport,
} from "./import.ts";

const fixture = (name: string) =>
  readFileSync(
    new URL(
      `../../apps/web/src/features/research-studies/fixtures/${name}`,
      import.meta.url
    ),
    "utf8"
  );
const SEEDED = fixture("adx-filter-study.json");
const QC_PORT = fixture("qc-port-study.json");
const qcPortLine = (id: string) =>
  JSON.stringify({
    ...(JSON.parse(QC_PORT) as object),
    id,
    spec: `docs/specs/strategies/${id}.md`,
  });
const UPDATED_AT = new Date("2026-11-07T12:00:00.000Z");

async function* chunks(...parts: readonly (Uint8Array | string)[]) {
  yield* parts;
}

type CliRun = Readonly<{ err: string[]; io: CliIo; out: string[] }>;

const cli = (
  stdin: AsyncIterable<Uint8Array | string>,
  env: NodeJS.ProcessEnv = { DATABASE_URL: "postgres://studies.test/db" }
): CliRun => {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    env,
    stderr: { write: (text: string) => err.push(text) > 0 },
    stdin,
    stdout: { write: (text: string) => out.push(text) > 0 },
  };
  return { err, io, out };
};

const storeDouble = (
  upsertMany: ResearchStudyStore["upsertMany"] = async (inputs) =>
    inputs.map((input) => ({
      created: true,
      id: input.id,
      updatedAt: UPDATED_AT,
    }))
) => {
  const urls: string[] = [];
  const close = vi.fn(async () => undefined);
  const upsertSpy = vi.fn(upsertMany);
  const open: OpenResearchStudyStore = (url) => {
    urls.push(url);
    return { close, upsertMany: upsertSpy };
  };
  return { close, open, upsertMany: upsertSpy, urls };
};

describe("parseStudyDocuments", () => {
  it("accepts the seeded ADX/RVOL study", () => {
    expect(parseStudyDocuments(SEEDED)).toMatchObject([
      {
        id: "adx-rvol-filters",
        ran: "2026-10-31",
        spec: "docs/specs/research/adx-filter.md",
      },
    ]);
  });

  it("accepts a pretty-printed qc-port study and JSON lines of either kind", () => {
    expect(parseStudyDocuments(QC_PORT)).toEqual([JSON.parse(QC_PORT)]);
    const lines = [
      qcPortLine("qc-opex-week"),
      "",
      JSON.stringify(JSON.parse(SEEDED)),
      `  ${qcPortLine("qc-vix-term-gate")}  `,
    ].join("\n");
    expect(parseStudyDocuments(lines).map((study) => study.id)).toEqual([
      "qc-opex-week",
      "adx-rvol-filters",
      "qc-vix-term-gate",
    ]);
  });

  it("rejects empty input, broken JSON, a wrong shape and an oversized document", () => {
    expect(() => parseStudyDocuments("  \n")).toThrow(
      /No study document on stdin/u
    );
    expect(() => parseStudyDocuments("{")).toThrow(
      /stdin is not one JSON document/u
    );
    expect(() => parseStudyDocuments('{"id":"adx-rvol-filters"}')).toThrow(
      /^The study document is not valid/u
    );
    expect(() =>
      parseStudyDocuments(
        JSON.stringify({ ...JSON.parse(QC_PORT), verdict: "KEEP" })
      )
    ).toThrow(/The study document is not valid:\n.*\n.*→ at verdict/u);
    const study = JSON.parse(SEEDED) as { daily: { universe: string[] } };
    study.daily.universe = Array.from({ length: 30_000 }, () => "SPY-PADDING");
    expect(() => parseStudyDocuments(JSON.stringify(study))).toThrow(
      /The study document is \d+ bytes; the limit is 262144/u
    );
  });

  it("names the line of a bad JSON line and refuses repeated ids or too many lines", () => {
    expect(() =>
      parseStudyDocuments(`${qcPortLine("qc-opex-week")}\n{"id":`)
    ).toThrow(/stdin is neither one JSON document nor JSON lines: line 2: /u);
    expect(() =>
      parseStudyDocuments(
        `${qcPortLine("qc-opex-week")}\n${JSON.stringify({ id: "qc-x", kind: "qc-port" })}`
      )
    ).toThrow(/^The study document on line 2 is not valid/u);
    expect(() =>
      parseStudyDocuments(
        `${qcPortLine("qc-opex-week")}\n${qcPortLine("qc-opex-week")}`
      )
    ).toThrow("Study qc-opex-week appears more than once on stdin");
    const many = Array.from({ length: RESEARCH_STUDY_BATCH_MAX + 1 }, (_, i) =>
      qcPortLine(`qc-port-${i}`)
    ).join("\n");
    expect(() => parseStudyDocuments(many)).toThrow(
      /stdin has 101 JSON lines; the limit is 100/u
    );
  });
});

describe("runResearchStudiesImport", () => {
  it("prints the usage for --help", async () => {
    const run = cli(chunks());
    await expect(runResearchStudiesImport(["--help"], run.io)).resolves.toBe(0);
    expect(run.out).toEqual([`${RESEARCH_STUDIES_IMPORT_USAGE}\n`]);
  });

  it("checks a document without a database on --dry-run", async () => {
    const store = storeDouble();
    const run = cli(chunks(SEEDED.slice(0, 100), SEEDED.slice(100)), {});
    await expect(
      runResearchStudiesImport(["--dry-run"], run.io, store.open)
    ).resolves.toBe(0);
    expect(JSON.parse(run.out.join(""))).toEqual({
      dryRun: true,
      id: "adx-rvol-filters",
      ranOn: "2026-10-31",
      specRef: "docs/specs/research/adx-filter.md",
    });
    expect(store.urls).toEqual([]);
  });

  it("upserts the document from stdin bytes and closes the store", async () => {
    const store = storeDouble();
    const run = cli(chunks(new TextEncoder().encode(SEEDED)));
    await expect(
      runResearchStudiesImport([], run.io, store.open)
    ).resolves.toBe(0);
    expect(store.urls).toEqual(["postgres://studies.test/db"]);
    expect(store.upsertMany).toHaveBeenCalledWith([
      {
        id: "adx-rvol-filters",
        ranOn: "2026-10-31",
        specRef: "docs/specs/research/adx-filter.md",
        summary: JSON.parse(SEEDED),
      },
    ]);
    expect(JSON.parse(run.out.join(""))).toEqual({
      created: true,
      id: "adx-rvol-filters",
      updatedAt: UPDATED_AT.toISOString(),
    });
    expect(store.close).toHaveBeenCalledTimes(1);
  });

  it("upserts every JSON line in one store call, in order, and prints one line per stored study", async () => {
    const store = storeDouble();
    const run = cli(
      chunks(
        `${qcPortLine("qc-opex-week")}\n${qcPortLine("qc-vix-term-gate")}\n`
      )
    );
    await expect(
      runResearchStudiesImport([], run.io, store.open)
    ).resolves.toBe(0);
    expect(store.upsertMany).toHaveBeenCalledTimes(1);
    const inputs = store.upsertMany.mock.calls[0]?.[0] ?? [];
    expect(inputs.map((input) => input.id)).toEqual([
      "qc-opex-week",
      "qc-vix-term-gate",
    ]);
    expect(inputs[0]).toMatchObject({
      ranOn: "2026-11-08",
      specRef: "docs/specs/strategies/qc-opex-week.md",
      summary: { kind: "qc-port" },
    });
    expect(run.out.map((line) => JSON.parse(line).id)).toEqual([
      "qc-opex-week",
      "qc-vix-term-gate",
    ]);
    expect(store.close).toHaveBeenCalledTimes(1);

    const dry = cli(
      chunks(
        `${qcPortLine("qc-opex-week")}\n${qcPortLine("qc-vix-term-gate")}`
      ),
      {}
    );
    await expect(
      runResearchStudiesImport(["--dry-run"], dry.io, store.open)
    ).resolves.toBe(0);
    expect(dry.out.map((line) => JSON.parse(line))).toEqual([
      {
        dryRun: true,
        id: "qc-opex-week",
        ranOn: "2026-11-08",
        specRef: "docs/specs/strategies/qc-opex-week.md",
      },
      {
        dryRun: true,
        id: "qc-vix-term-gate",
        ranOn: "2026-11-08",
        specRef: "docs/specs/strategies/qc-vix-term-gate.md",
      },
    ]);
  });

  it("exits 2 on usage and input problems without opening the store", async () => {
    const store = storeDouble();
    const cases: Array<readonly [readonly string[], CliRun, RegExp]> = [
      [["--force"], cli(chunks(SEEDED)), /Unknown argument --force/u],
      [[], cli(chunks(SEEDED), {}), /DATABASE_URL is required/u],
      [
        [],
        cli(chunks(SEEDED), { DATABASE_URL: "" }),
        /DATABASE_URL is required/u,
      ],
      [[], cli(chunks(new Uint8Array([0xff, 0xfe]))), /not UTF-8 text/u],
      [
        [],
        cli(chunks("x".repeat(RESEARCH_STUDY_INPUT_MAX_BYTES), "x")),
        /stdin is larger than 1048576 bytes/u,
      ],
    ];
    for (const [argv, run, message] of cases) {
      await expect(
        runResearchStudiesImport(argv, run.io, store.open)
      ).resolves.toBe(2);
      expect(run.err.join("")).toMatch(message);
      expect(run.out).toEqual([]);
    }
    expect(store.urls).toEqual([]);
  });

  it("exits 2 when the database checks reject the document", async () => {
    const rejecting = storeDouble(async () => {
      throw new InvalidRepositoryInputError(
        "research study fails research_studies_summary_check"
      );
    });
    const run = cli(
      chunks(`${qcPortLine("qc-opex-week")}\n${qcPortLine("qc-vix-term-gate")}`)
    );
    await expect(
      runResearchStudiesImport([], run.io, rejecting.open)
    ).resolves.toBe(2);
    expect(run.err.join("")).toBe(
      "Invalid repository input: research study fails research_studies_summary_check\n"
    );
    // The batch is one transaction: nothing stored, so no result line.
    expect(run.out).toEqual([]);
    expect(rejecting.close).toHaveBeenCalledTimes(1);
  });

  it("exits 1 when the store fails, and still closes it", async () => {
    const failing = storeDouble(async () => {
      throw new Error("Invalid repository input: research study fails a check");
    });
    const run = cli(chunks(SEEDED));
    await expect(
      runResearchStudiesImport([], run.io, failing.open)
    ).resolves.toBe(1);
    expect(run.err.join("")).toBe(
      "research study import failed: Invalid repository input: research study fails a check\n"
    );
    expect(failing.close).toHaveBeenCalledTimes(1);

    const odd = storeDouble(() => Promise.reject("socket closed"));
    const second = cli(chunks(SEEDED));
    await expect(
      runResearchStudiesImport([], second.io, odd.open)
    ).resolves.toBe(1);
    expect(second.err.join("")).toBe(
      "research study import failed: socket closed\n"
    );
  });

  it("opens a real store lazily: the default opener connects only on use", async () => {
    const store = openResearchStudyStore(
      "postgresql://nobody:nothing@127.0.0.1:1/none"
    );
    await expect(
      store.upsertMany([
        {
          id: "adx-rvol-filters",
          ranOn: "2026-10-31",
          specRef: "docs/specs/research/adx-filter.md",
          summary: {},
        },
      ])
    ).rejects.toThrow();
    await store.close();
  });
});
