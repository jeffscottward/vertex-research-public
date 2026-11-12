import type * as DatabaseServer from "@darkfactory/db/server";
import { InvalidRepositoryInputError } from "@darkfactory/db/server";
import { describe, expect, it, vi } from "vitest";

import {
  type CliIo,
  LEVERAGED_ETF_UNIVERSE_IMPORT_USAGE,
  LEVERAGED_ETF_UNIVERSE_INPUT_MAX_BYTES,
  type LeveragedEtfUniverseStore,
  type OpenLeveragedEtfUniverseStore,
  parseUniverseDocument,
  runLeveragedEtfUniverseImport,
} from "./import.ts";

// The database that the default opener of the CLI gets: no test opens a TCP connection.
const database = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  connectionStrings: [] as string[],
  transaction: vi.fn(),
}));

vi.mock("@darkfactory/db/server", async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseServer>()),
  createNodeDatabase: ({ connectionString }: { connectionString: string }) => {
    database.connectionStrings.push(connectionString);
    return { close: database.close, db: { transaction: database.transaction } };
  },
}));

const OPTIONS = {
  bandOpenInterest: 23_456,
  halfSpreadPct: 1.2,
  nearestExpiries: ["2026-11-13", "2026-11-20"],
  quotedAt: "2026-11-11T15:20:00Z",
  session: "regular",
  spot: 58.65,
  totalOpenInterest: 123_456,
  twoSidedQuotes: 8,
  windowExpiry: "2026-11-20",
};
const fund = (symbol: string, overrides: Record<string, unknown> = {}) => ({
  leverage: 3,
  listingExchange: "NASDAQ",
  name: `${symbol} 3x fund`,
  optionGate: "pass",
  optionGateReasons: [],
  options: OPTIONS,
  optionsListed: true,
  productType: "etf",
  symbol,
  underlying: null,
  ...overrides,
});
// Two pass, one fail, one spread-not-measured.
const DOCUMENT = {
  funds: [
    fund("AAA"),
    fund("BBB", {
      optionGate: "fail",
      optionGateReasons: ["no-listed-options"],
      options: null,
      optionsListed: false,
    }),
    fund("CCC", {
      optionGate: "spread-not-measured",
      optionGateReasons: ["market-closed-at-quote"],
      options: { ...OPTIONS, session: "closed" },
    }),
    fund("DDD"),
  ],
  gate: {
    bandPct: 10,
    maxHalfSpreadPct: 4,
    maxWindowDays: 21,
    minBandOpenInterest: 1000,
    minTwoSidedQuotes: 3,
    minWindowDays: 5,
    version: 1,
  },
  generatedAt: "2026-11-11T15:30:00Z",
  schema: "leveraged-etf-universe-v1",
};
const TEXT = JSON.stringify(DOCUMENT);
const COUNTS = {
  generatedAt: "2026-11-11T15:30:00Z",
  funds: 4,
  pass: 2,
  fail: 1,
  "spread-not-measured": 1,
};

async function* chunks(...parts: readonly (Uint8Array | string)[]) {
  yield* parts;
}

type CliRun = Readonly<{ err: string[]; io: CliIo; out: string[] }>;

const cli = (
  stdin: AsyncIterable<Uint8Array | string>,
  env: NodeJS.ProcessEnv = { DATABASE_URL: "postgres://universe.test/db" }
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
  replaceUniverse: LeveragedEtfUniverseStore["replaceUniverse"] = async (
    document
  ) => ({ deleted: 1, upserted: document.funds.length })
) => {
  const urls: string[] = [];
  const close = vi.fn(async () => undefined);
  const replaceSpy = vi.fn(replaceUniverse);
  const open: OpenLeveragedEtfUniverseStore = (url) => {
    urls.push(url);
    return { close, replaceUniverse: replaceSpy };
  };
  return { close, open, replaceUniverse: replaceSpy, urls };
};

describe("parseUniverseDocument", () => {
  it("accepts a compact and a pretty-printed document", () => {
    expect(parseUniverseDocument(TEXT)).toEqual(DOCUMENT);
    expect(
      parseUniverseDocument(`${JSON.stringify(DOCUMENT, null, 2)}\n`)
    ).toEqual(DOCUMENT);
  });

  it("rejects empty input, broken JSON and a document that breaks the schema", () => {
    expect(() => parseUniverseDocument(" \n")).toThrow(
      `No universe document on stdin.\n${LEVERAGED_ETF_UNIVERSE_IMPORT_USAGE}`
    );
    expect(() => parseUniverseDocument("{")).toThrow(
      /^stdin is not one JSON document: /u
    );
    // JSON lines are not one document.
    expect(() => parseUniverseDocument(`${TEXT}\n${TEXT}`)).toThrow(
      /^stdin is not one JSON document: /u
    );
    expect(() =>
      parseUniverseDocument(
        JSON.stringify({ ...DOCUMENT, funds: [fund("AAA"), fund("AAA")] })
      )
    ).toThrow(
      /^The universe document is not valid:\n[\s\S]*symbol AAA appears more than once/u
    );
  });
});

describe("runLeveragedEtfUniverseImport", () => {
  it("prints the usage for --help", async () => {
    const run = cli(chunks());
    await expect(
      runLeveragedEtfUniverseImport(["--help"], run.io, storeDouble().open)
    ).resolves.toBe(0);
    expect(run.out).toEqual([`${LEVERAGED_ETF_UNIVERSE_IMPORT_USAGE}\n`]);
  });

  it("checks a document and prints the gate counts without a database on --dry-run", async () => {
    const store = storeDouble();
    const run = cli(chunks(TEXT), {});
    await expect(
      runLeveragedEtfUniverseImport(["--dry-run"], run.io, store.open)
    ).resolves.toBe(0);
    expect(run.out).toHaveLength(1);
    expect(run.out[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(run.out.join(""))).toEqual({ dryRun: true, ...COUNTS });
    expect(run.err).toEqual([]);
    expect(store.urls).toEqual([]);
  });

  it("replaces the universe from stdin bytes, prints one line of counts and closes the store", async () => {
    const store = storeDouble();
    const bytes = new TextEncoder().encode(TEXT);
    const run = cli(chunks(bytes.slice(0, 100), bytes.slice(100)));
    await expect(
      runLeveragedEtfUniverseImport([], run.io, store.open)
    ).resolves.toBe(0);
    expect(store.urls).toEqual(["postgres://universe.test/db"]);
    expect(store.replaceUniverse).toHaveBeenCalledTimes(1);
    expect(store.replaceUniverse).toHaveBeenCalledWith(DOCUMENT);
    expect(run.out).toEqual([
      `${JSON.stringify({ ...COUNTS, upserted: 4, deleted: 1 })}\n`,
    ]);
    expect(run.err).toEqual([]);
    expect(store.close).toHaveBeenCalledTimes(1);
  });

  it("exits 2 on usage and input problems without opening the store", async () => {
    const store = storeDouble();
    const cases: Array<readonly [readonly string[], CliRun, RegExp]> = [
      [["--force"], cli(chunks(TEXT)), /Unknown argument --force/u],
      [[], cli(chunks(TEXT), {}), /DATABASE_URL is required/u],
      [
        [],
        cli(chunks(TEXT), { DATABASE_URL: "" }),
        /DATABASE_URL is required/u,
      ],
      [[], cli(chunks(new Uint8Array([0xff, 0xfe]))), /not UTF-8 text/u],
      [[], cli(chunks()), /No universe document on stdin/u],
      [
        ["--dry-run"],
        cli(chunks('{"schema":"other"}')),
        /The universe document is not valid/u,
      ],
      [
        [],
        cli(chunks("x".repeat(LEVERAGED_ETF_UNIVERSE_INPUT_MAX_BYTES), "x")),
        /stdin is larger than 2097152 bytes/u,
      ],
    ];
    for (const [argv, run, message] of cases) {
      await expect(
        runLeveragedEtfUniverseImport(argv, run.io, store.open)
      ).resolves.toBe(2);
      expect(run.err.join("")).toMatch(message);
      expect(run.out).toEqual([]);
    }
    expect(store.urls).toEqual([]);
  });

  it("exits 2 when the database refuses the document, and still closes the store", async () => {
    const refusing = storeDouble(async () => {
      throw new InvalidRepositoryInputError(
        "leveraged ETF universe document generated at 2026-11-11T15:30:00.000Z is older than the stored universe (2026-11-12T15:30:00.000Z)"
      );
    });
    const run = cli(chunks(TEXT));
    await expect(
      runLeveragedEtfUniverseImport([], run.io, refusing.open)
    ).resolves.toBe(2);
    expect(run.err.join("")).toBe(
      "Invalid repository input: leveraged ETF universe document generated at 2026-11-11T15:30:00.000Z is older than the stored universe (2026-11-12T15:30:00.000Z)\n"
    );
    // One transaction: nothing stored, so no result line.
    expect(run.out).toEqual([]);
    expect(refusing.close).toHaveBeenCalledTimes(1);
  });

  it("exits 1 when the store fails, and still closes it", async () => {
    const failing = storeDouble(async () => {
      throw new Error(
        "Database operation failed: leveraged ETF universe replace"
      );
    });
    const run = cli(chunks(TEXT));
    await expect(
      runLeveragedEtfUniverseImport([], run.io, failing.open)
    ).resolves.toBe(1);
    expect(run.err.join("")).toBe(
      "leveraged ETF universe import failed: Database operation failed: leveraged ETF universe replace\n"
    );
    expect(run.out).toEqual([]);
    expect(failing.close).toHaveBeenCalledTimes(1);

    const odd = storeDouble(() => Promise.reject("socket closed"));
    const second = cli(chunks(TEXT));
    await expect(
      runLeveragedEtfUniverseImport([], second.io, odd.open)
    ).resolves.toBe(1);
    expect(second.err.join("")).toBe(
      "leveraged ETF universe import failed: socket closed\n"
    );
  });

  it("exits 2 for a document that is generated more than 5 minutes after the current time", async () => {
    const store = storeDouble();
    // DOCUMENT is generated at 15:30:00; the clock of the import says 15:24:59.
    for (const argv of [[], ["--dry-run"]]) {
      const run = cli(chunks(TEXT));
      await expect(
        runLeveragedEtfUniverseImport(
          argv,
          run.io,
          store.open,
          () => new Date("2026-11-11T15:24:59Z")
        )
      ).resolves.toBe(2);
      expect(run.err.join("")).toBe(
        "The universe document is generated at 2026-11-11T15:30:00Z. That is more than 5 minutes after the current time 2026-11-11T15:24:59.000Z, so it is refused.\n"
      );
      expect(run.out).toEqual([]);
    }
    expect(store.urls).toEqual([]);
    // One second later the document is 5 minutes ahead: two clocks may differ by that much.
    const run = cli(chunks(TEXT));
    await expect(
      runLeveragedEtfUniverseImport(
        [],
        run.io,
        store.open,
        () => new Date("2026-11-11T15:25:00Z")
      )
    ).resolves.toBe(0);
    expect(store.replaceUniverse).toHaveBeenCalledTimes(1);
  });

  it("opens the store of DATABASE_URL by default, exits 1 when the database cannot be reached and closes the store", async () => {
    database.transaction.mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
        code: "ECONNREFUSED",
      })
    );
    const run = cli(chunks(TEXT));
    // No opener is passed: the CLI builds the store from createNodeDatabase and the repository.
    await expect(runLeveragedEtfUniverseImport([], run.io)).resolves.toBe(1);
    expect(database.connectionStrings).toEqual(["postgres://universe.test/db"]);
    expect(database.transaction).toHaveBeenCalledTimes(1);
    // The repository maps the connection failure; the address of the database is not printed.
    expect(run.err.join("")).toBe(
      "leveraged ETF universe import failed: Database operation failed: leveraged ETF universe replace\n"
    );
    expect(run.out).toEqual([]);
    expect(database.close).toHaveBeenCalledTimes(1);
  });
});
