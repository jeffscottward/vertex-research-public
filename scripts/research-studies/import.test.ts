import { readFileSync } from "node:fs";

import { InvalidRepositoryInputError } from "@darkfactory/db/server";
import { describe, expect, it, vi } from "vitest";

import {
  type CliIo,
  type OpenResearchStudyStore,
  openResearchStudyStore,
  parseStudyDocument,
  RESEARCH_STUDIES_IMPORT_USAGE,
  RESEARCH_STUDY_INPUT_MAX_BYTES,
  type ResearchStudyStore,
  runResearchStudiesImport,
} from "./import.ts";

const SEEDED = readFileSync(
  new URL(
    "../../apps/web/src/features/research-studies/fixtures/adx-filter-study.json",
    import.meta.url
  ),
  "utf8"
);
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
  upsert: ResearchStudyStore["upsert"] = async (input) => ({
    created: true,
    id: input.id,
    updatedAt: UPDATED_AT,
  })
) => {
  const urls: string[] = [];
  const close = vi.fn(async () => undefined);
  const upsertSpy = vi.fn(upsert);
  const open: OpenResearchStudyStore = (url) => {
    urls.push(url);
    return { close, upsert: upsertSpy };
  };
  return { close, open, upsert: upsertSpy, urls };
};

describe("parseStudyDocument", () => {
  it("accepts the seeded ADX/RVOL study", () => {
    expect(parseStudyDocument(SEEDED)).toMatchObject({
      id: "adx-rvol-filters",
      ran: "2026-10-31",
      spec: "docs/specs/research/adx-filter.md",
    });
  });

  it("rejects empty input, broken JSON, a wrong shape and an oversized document", () => {
    expect(() => parseStudyDocument("  \n")).toThrow(
      /No study document on stdin/u
    );
    expect(() => parseStudyDocument("{")).toThrow(
      /stdin is not one JSON document/u
    );
    expect(() => parseStudyDocument('{"id":"adx-rvol-filters"}')).toThrow(
      /The study document is not valid/u
    );
    const study = JSON.parse(SEEDED) as { daily: { universe: string[] } };
    study.daily.universe = Array.from({ length: 30_000 }, () => "SPY-PADDING");
    expect(() => parseStudyDocument(JSON.stringify(study))).toThrow(
      /The study document is \d+ bytes; the limit is 262144/u
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
    expect(store.upsert).toHaveBeenCalledWith({
      id: "adx-rvol-filters",
      ranOn: "2026-10-31",
      specRef: "docs/specs/research/adx-filter.md",
      summary: JSON.parse(SEEDED),
    });
    expect(JSON.parse(run.out.join(""))).toEqual({
      created: true,
      id: "adx-rvol-filters",
      updatedAt: UPDATED_AT.toISOString(),
    });
    expect(store.close).toHaveBeenCalledTimes(1);
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
    const run = cli(chunks(SEEDED));
    await expect(
      runResearchStudiesImport([], run.io, rejecting.open)
    ).resolves.toBe(2);
    expect(run.err.join("")).toBe(
      "Invalid repository input: research study fails research_studies_summary_check\n"
    );
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
      store.upsert({
        id: "adx-rvol-filters",
        ranOn: "2026-10-31",
        specRef: "docs/specs/research/adx-filter.md",
        summary: {},
      })
    ).rejects.toThrow();
    await store.close();
  });
});
