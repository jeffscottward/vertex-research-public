import { leveragedEtfUniverse } from "@darkfactory/db/schema";
import {
  createLeveragedEtfUniverseRepository,
  createNodeDatabase,
  type Database,
  InvalidRepositoryInputError,
  type LeveragedEtfUniverseDocument,
} from "@darkfactory/db/server";
import { migrate } from "@darkfactory/db/server/migration";
import {
  createPostgresTestDatabase,
  dropPostgresTestDatabase,
  type PostgresTestDatabase,
} from "@darkfactory/testkit/postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  LEVERAGED_ETF_GATE_CONSTANTS,
  LeveragedEtfUniverseDocumentSchema,
} from "../../../scripts/leveraged-etf-universe/document.ts";
import { runLeveragedEtfUniverseImport } from "../../../scripts/leveraged-etf-universe/import.ts";

type Fund = LeveragedEtfUniverseDocument["funds"][number];
/** The option facts of a document: the facts that the table stores, and the quote count. */
type Options = NonNullable<Fund["options"]> &
  Readonly<{ twoSidedQuotes: number }>;

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const database = (): Database => {
  if (resource === undefined) throw new Error("Database not started");
  return resource.db;
};

// The constants of gate version 1. The table has no column for minTwoSidedQuotes.
const GATE = { ...LEVERAGED_ETF_GATE_CONSTANTS[1], version: 1 };
// 10:20 in New York on 2026-11-11, 10 minutes before FIRST_AT.
const OPTIONS: Options = {
  bandOpenInterest: 23_456,
  halfSpreadPct: 1.2,
  nearestExpiries: ["2026-11-13", "2026-11-20", "2026-11-27", "2026-12-04"],
  quotedAt: "2026-11-11T15:20:00Z",
  session: "regular",
  spot: 58.65,
  totalOpenInterest: 123_456,
  twoSidedQuotes: 8,
  windowExpiry: "2026-11-20",
};
// 18:05 in New York on the day before: after the close.
const CLOSED_OPTIONS: Options = {
  ...OPTIONS,
  halfSpreadPct: null,
  quotedAt: "2026-11-10T23:05:00Z",
  session: "closed",
  twoSidedQuotes: 0,
};
const PASS: Fund = {
  leverage: 3,
  listingExchange: "NASDAQ",
  name: "ProShares UltraPro QQQ",
  optionGate: "pass",
  optionGateReasons: [],
  options: OPTIONS,
  optionsListed: true,
  productType: "etf",
  symbol: "TQQQ",
  underlying: "QQQ",
};
const FAIL: Fund = {
  leverage: -1.25,
  listingExchange: "NYSE ARCA",
  name: "Example 1.25x Inverse Note",
  optionGate: "fail",
  optionGateReasons: ["no-listed-options"],
  options: null,
  optionsListed: false,
  productType: "etn",
  symbol: "AAAZ",
  underlying: null,
};
const NOT_MEASURED: Fund = {
  ...PASS,
  leverage: 2,
  name: "Example 2x Semiconductor Fund",
  optionGate: "spread-not-measured",
  optionGateReasons: ["market-closed-at-quote"],
  options: CLOSED_OPTIONS,
  symbol: "SEMI",
  underlying: "SMH",
};
const FUNDS = [FAIL, NOT_MEASURED, PASS];
const QUOTE_COUNTS: Readonly<Record<string, number>> = { SEMI: 0, TQQQ: 8 };
// Three times on 2026-11-11 in New York, the day of the chains above.
const FIRST_AT = "2026-11-11T15:30:00Z";
const SECOND_AT = "2026-11-11T15:31:00Z";
const THIRD_AT = "2026-11-11T15:32:00Z";
const documentOf = (
  funds: readonly Fund[],
  generatedAt = FIRST_AT
): LeveragedEtfUniverseDocument => ({ funds, gate: GATE, generatedAt });

const repository = () => createLeveragedEtfUniverseRepository(database());
const storedRows = async () =>
  (await database().select().from(leveragedEtfUniverse)).sort((left, right) =>
    left.symbol.localeCompare(right.symbol)
  );
const storedSymbols = async () => (await storedRows()).map((row) => row.symbol);

describe("leveraged ETF universe repository (Postgres)", () => {
  beforeAll(async () => {
    testDatabase = await createPostgresTestDatabase();
    resource = createNodeDatabase({
      connectionString: testDatabase.databaseUrl,
      maxConnections: 4,
    });
    await migrate(resource.db);
  }, 60_000);

  // Every test starts with an empty table and stores the rows that it needs.
  beforeEach(async () => {
    await database().delete(leveragedEtfUniverse);
  });

  afterAll(async () => {
    await resource?.close();
    if (testDatabase !== undefined)
      await dropPostgresTestDatabase(testDatabase);
  });

  it("stores one flat row per fund", async () => {
    expect(await storedRows()).toEqual([]);
    await expect(
      repository().replaceUniverse(documentOf(FUNDS))
    ).resolves.toEqual({ deleted: 0, upserted: 3 });
    const [fail, notMeasured, pass] = await storedRows();
    expect(pass).toEqual({
      bandOpenInterest: 23_456,
      gateBandPct: 10,
      gateMaxHalfSpreadPct: 4,
      gateMaxWindowDays: 21,
      gateMinBandOpenInterest: 1000,
      gateMinWindowDays: 5,
      gateVersion: 1,
      generatedAt: new Date(FIRST_AT),
      halfSpreadPct: 1.2,
      leverage: 3,
      listingExchange: "NASDAQ",
      name: "ProShares UltraPro QQQ",
      nearestExpiries: ["2026-11-13", "2026-11-20", "2026-11-27", "2026-12-04"],
      optionGate: "pass",
      optionGateReasons: [],
      optionsListed: true,
      productType: "etf",
      quotedAt: new Date("2026-11-11T15:20:00Z"),
      quoteSession: "regular",
      spot: 58.65,
      symbol: "TQQQ",
      totalOpenInterest: 123_456,
      underlying: "QQQ",
      updatedAt: expect.any(Date),
      windowExpiry: "2026-11-20",
    });
    expect(fail).toMatchObject({
      bandOpenInterest: null,
      halfSpreadPct: null,
      leverage: -1.25,
      nearestExpiries: [],
      optionGate: "fail",
      optionGateReasons: ["no-listed-options"],
      optionsListed: false,
      quotedAt: null,
      quoteSession: null,
      spot: null,
      symbol: "AAAZ",
      totalOpenInterest: null,
      underlying: null,
      windowExpiry: null,
    });
    expect(notMeasured).toMatchObject({
      halfSpreadPct: null,
      optionGate: "spread-not-measured",
      optionGateReasons: ["market-closed-at-quote"],
      quoteSession: "closed",
      symbol: "SEMI",
    });
  });

  it("stores the reasons that the gate rule got after migration 0068", async () => {
    // The table checks the label and the count of the reasons, not their names.
    await expect(
      repository().replaceUniverse(
        documentOf([
          { ...FAIL, optionGateReasons: ["no-standard-contract"] },
          {
            ...NOT_MEASURED,
            optionGate: "fail",
            optionGateReasons: ["stale-chain"],
          },
          {
            ...PASS,
            optionGate: "fail",
            optionGateReasons: ["too-few-two-sided-quotes"],
          },
        ])
      )
    ).resolves.toEqual({ deleted: 0, upserted: 3 });
    expect((await storedRows()).map((row) => row.optionGateReasons)).toEqual([
      ["no-standard-contract"],
      ["stale-chain"],
      ["too-few-two-sided-quotes"],
    ]);
  });

  it("replaces a changed fund and deletes a fund that left the universe", async () => {
    await repository().replaceUniverse(documentOf(FUNDS));
    const before = (await storedRows()).find((row) => row.symbol === "TQQQ");
    await expect(
      repository().replaceUniverse(
        documentOf(
          [
            FAIL,
            {
              ...PASS,
              optionGate: "fail",
              optionGateReasons: ["open-interest-below-minimum"],
              options: { ...OPTIONS, bandOpenInterest: 12 },
            },
          ],
          SECOND_AT
        )
      )
    ).resolves.toEqual({ deleted: 1, upserted: 2 });
    const rows = await storedRows();
    expect(rows.map((row) => row.symbol)).toEqual(["AAAZ", "TQQQ"]);
    expect(rows.map((row) => row.generatedAt)).toEqual([
      new Date(SECOND_AT),
      new Date(SECOND_AT),
    ]);
    expect(rows[1]).toMatchObject({
      bandOpenInterest: 12,
      optionGate: "fail",
      optionGateReasons: ["open-interest-below-minimum"],
    });
    expect(rows[1]?.updatedAt.getTime()).toBeGreaterThan(
      before?.updatedAt.getTime() ?? Number.POSITIVE_INFINITY
    );
  });

  it("refuses a document older than the stored universe and accepts one of the same time", async () => {
    await repository().replaceUniverse(documentOf([FAIL, PASS], SECOND_AT));
    await expect(
      repository().replaceUniverse(documentOf(FUNDS, FIRST_AT))
    ).rejects.toThrow(
      new InvalidRepositoryInputError(
        "leveraged ETF universe document generated at 2026-11-11T15:30:00.000Z is older than the stored universe (2026-11-11T15:31:00.000Z)"
      )
    );
    expect(await storedSymbols()).toEqual(["AAAZ", "TQQQ"]);
    await expect(
      repository().replaceUniverse(documentOf(FUNDS, SECOND_AT))
    ).resolves.toEqual({ deleted: 0, upserted: 3 });
    expect(await storedSymbols()).toEqual(["AAAZ", "SEMI", "TQQQ"]);
  });

  it("rejects rows that break a check and changes nothing in that transaction", async () => {
    await repository().replaceUniverse(documentOf(FUNDS));
    const cases: readonly (readonly [Fund, RegExp | string])[] = [
      [{ ...PASS, leverage: 1 }, /leveraged_etf_universe_fund_check/u],
      [{ ...PASS, symbol: "tqqq" }, /leveraged_etf_universe_fund_check/u],
      [
        { ...PASS, productType: "fund" as Fund["productType"] },
        /leveraged_etf_universe_fund_check/u,
      ],
      // Option facts for a fund without listed options, and the reverse.
      [{ ...FAIL, options: OPTIONS }, /leveraged_etf_universe_options_check/u],
      [
        { ...FAIL, optionsListed: true },
        /leveraged_etf_universe_options_check/u,
      ],
      [
        { ...PASS, options: { ...OPTIONS, windowExpiry: null } },
        /leveraged_etf_universe_options_check/u,
      ],
      [
        { ...PASS, options: { ...OPTIONS, nearestExpiries: [] } },
        /leveraged_etf_universe_options_check/u,
      ],
      // A pass with a reason, a pass after the close, a fail with no reason, an unknown label.
      [
        { ...PASS, optionGateReasons: ["spread-above-maximum"] },
        /leveraged_etf_universe_gate_check/u,
      ],
      [
        { ...PASS, options: { ...OPTIONS, session: "closed" } },
        /leveraged_etf_universe_gate_check/u,
      ],
      [
        { ...FAIL, optionGateReasons: [] },
        /leveraged_etf_universe_gate_check/u,
      ],
      [
        { ...NOT_MEASURED, optionGateReasons: [] },
        /leveraged_etf_universe_gate_check/u,
      ],
      [
        { ...FAIL, optionGate: "maybe" as Fund["optionGate"] },
        /leveraged_etf_universe_gate_check/u,
      ],
      [
        { ...PASS, options: { ...OPTIONS, windowExpiry: "2026-02-30" } },
        "leveraged ETF universe has an invalid date",
      ],
      [
        { ...PASS, leverage: 100 },
        "leveraged ETF universe has a number out of range",
      ],
    ];
    for (const [fund, message] of cases) {
      const attempt = repository().replaceUniverse(
        // A valid new fund next to the bad one: neither is stored.
        documentOf([{ ...FAIL, symbol: "ZZZZ" }, fund], SECOND_AT)
      );
      await expect(attempt).rejects.toThrow(InvalidRepositoryInputError);
      await expect(attempt).rejects.toThrow(message);
    }
    await expect(
      repository().replaceUniverse({
        ...documentOf([FAIL], SECOND_AT),
        gate: { ...GATE, maxWindowDays: 4 },
      })
    ).rejects.toThrow(/leveraged_etf_universe_gate_check/u);
    // No ZZZZ row, no deleted row and no newer generated_at.
    const rows = await storedRows();
    expect(rows.map((row) => row.symbol)).toEqual(["AAAZ", "SEMI", "TQQQ"]);
    expect(
      rows.every((row) => row.generatedAt.getTime() === Date.parse(FIRST_AT))
    ).toBe(true);
  });

  it("serializes two replaces: the table always ends as the newer document", async () => {
    await repository().replaceUniverse(documentOf(FUNDS));
    for (let round = 1; round <= 5; round += 1) {
      // Both documents are newer than the stored universe, so each round is a race of two writers.
      const older = new Date(Date.parse(FIRST_AT) + round * 120_000);
      const newer = new Date(older.getTime() + 60_000);
      const [first, second] = await Promise.allSettled([
        repository().replaceUniverse(
          documentOf([FAIL, PASS], older.toISOString())
        ),
        repository().replaceUniverse(
          documentOf([NOT_MEASURED, PASS], newer.toISOString())
        ),
      ]);
      // The older document is stored first, or refused because the newer one is already stored.
      if (first.status === "rejected")
        expect(first.reason).toBeInstanceOf(InvalidRepositoryInputError);
      expect(second.status).toBe("fulfilled");
      const rows = await storedRows();
      expect(rows.map((row) => row.symbol)).toEqual(["SEMI", "TQQQ"]);
      expect(rows.map((row) => row.generatedAt)).toEqual([newer, newer]);
    }
  });

  it("imports a document through the CLI and deletes a removed fund on the next import", async () => {
    const importDocument = async (
      funds: readonly Fund[],
      generatedAt: string
    ) => {
      const out: string[] = [];
      const err: string[] = [];
      async function* stdin() {
        yield JSON.stringify({
          ...documentOf(funds, generatedAt),
          schema: "leveraged-etf-universe-v1",
        });
      }
      const code = await runLeveragedEtfUniverseImport(
        [],
        {
          env: { DATABASE_URL: testDatabase?.databaseUrl },
          stderr: { write: (line: string) => err.push(line) > 0 },
          stdin: stdin(),
          stdout: { write: (line: string) => out.push(line) > 0 },
        },
        // The default store, and the clock of the minute after the last document.
        undefined,
        () => new Date("2026-11-11T15:33:00Z")
      );
      return { code, err, out: out.join("") };
    };
    const first = await importDocument(FUNDS, FIRST_AT);
    expect([first.code, first.err]).toEqual([0, []]);
    expect(JSON.parse(first.out)).toEqual({
      deleted: 0,
      fail: 1,
      funds: 3,
      generatedAt: FIRST_AT,
      pass: 1,
      "spread-not-measured": 1,
      upserted: 3,
    });
    const second = await importDocument([NOT_MEASURED, PASS], SECOND_AT);
    expect([second.code, second.err]).toEqual([0, []]);
    expect(JSON.parse(second.out)).toMatchObject({ deleted: 1, upserted: 2 });
    expect(await storedSymbols()).toEqual(["SEMI", "TQQQ"]);
    const stale = await importDocument([FAIL], FIRST_AT);
    expect(stale.code).toBe(2);
    expect(stale.err.join("")).toMatch(/is older than the stored universe/u);
    expect(await storedSymbols()).toEqual(["SEMI", "TQQQ"]);
    // A document of a later day: its chains are not of that day, so the schema refuses the pass.
    const nextDay = await importDocument(FUNDS, "2026-11-12T15:30:00Z");
    expect(nextDay.code).toBe(2);
    expect(nextDay.err.join("")).toMatch(/TQQQ: must be "closed"/u);
    expect(await storedSymbols()).toEqual(["SEMI", "TQQQ"]);
  });

  it("stores rows that rebuild a document the import schema accepts, with the two values that have no column", async () => {
    await repository().replaceUniverse(documentOf(FUNDS, THIRD_AT));
    const rows = await storedRows();
    expect(rows.map((row) => row.optionGate)).toEqual([
      "fail",
      "spread-not-measured",
      "pass",
    ]);
    // The table does not hold options.twoSidedQuotes and gate.minTwoSidedQuotes: the first comes
    // from the document that was stored, the second from the constants of the gate version.
    const rebuilt = {
      funds: rows.map((row) => ({
        leverage: row.leverage,
        listingExchange: row.listingExchange,
        name: row.name,
        optionGate: row.optionGate,
        optionGateReasons: row.optionGateReasons,
        options: row.optionsListed
          ? {
              bandOpenInterest: row.bandOpenInterest,
              halfSpreadPct: row.halfSpreadPct,
              nearestExpiries: row.nearestExpiries,
              quotedAt: row.quotedAt?.toISOString(),
              session: row.quoteSession,
              spot: row.spot,
              totalOpenInterest: row.totalOpenInterest,
              twoSidedQuotes: QUOTE_COUNTS[row.symbol],
              windowExpiry: row.windowExpiry,
            }
          : null,
        optionsListed: row.optionsListed,
        productType: row.productType,
        symbol: row.symbol,
        underlying: row.underlying,
      })),
      gate: {
        bandPct: rows[0]?.gateBandPct,
        maxHalfSpreadPct: rows[0]?.gateMaxHalfSpreadPct,
        maxWindowDays: rows[0]?.gateMaxWindowDays,
        minBandOpenInterest: rows[0]?.gateMinBandOpenInterest,
        minTwoSidedQuotes: LEVERAGED_ETF_GATE_CONSTANTS[1].minTwoSidedQuotes,
        minWindowDays: rows[0]?.gateMinWindowDays,
        version: rows[0]?.gateVersion,
      },
      generatedAt: rows[0]?.generatedAt.toISOString(),
      schema: "leveraged-etf-universe-v1",
    };
    const parsed = LeveragedEtfUniverseDocumentSchema.safeParse(rebuilt);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });
});
