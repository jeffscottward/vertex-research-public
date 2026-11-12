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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LeveragedEtfUniverseDocumentSchema } from "../../../scripts/leveraged-etf-universe/document.ts";
import { runLeveragedEtfUniverseImport } from "../../../scripts/leveraged-etf-universe/import.ts";

type Fund = LeveragedEtfUniverseDocument["funds"][number];

let testDatabase: PostgresTestDatabase | undefined;
let resource: { db: Database; close: () => Promise<void> } | undefined;

const database = (): Database => {
  if (resource === undefined) throw new Error("Database not started");
  return resource.db;
};

const GATE = {
  bandPct: 10,
  maxHalfSpreadPct: 4,
  maxWindowDays: 21,
  minBandOpenInterest: 1000,
  minWindowDays: 5,
  version: 1,
};
const OPTIONS: NonNullable<Fund["options"]> = {
  bandOpenInterest: 23_456,
  halfSpreadPct: 1.2,
  nearestExpiries: ["2026-11-13", "2026-11-20", "2026-11-27", "2026-12-04"],
  quotedAt: "2026-11-11T15:20:00Z",
  session: "regular",
  spot: 58.65,
  totalOpenInterest: 123_456,
  windowExpiry: "2026-11-20",
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
  options: {
    ...OPTIONS,
    halfSpreadPct: null,
    quotedAt: "2026-11-10T23:05:00Z",
    session: "closed",
  },
  symbol: "SEMI",
  underlying: "SMH",
};
const FIRST_AT = "2026-11-11T15:30:00Z";
const documentOf = (
  funds: readonly Fund[],
  generatedAt = FIRST_AT
): LeveragedEtfUniverseDocument => ({ funds, gate: GATE, generatedAt });

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

  afterAll(async () => {
    await resource?.close();
    if (testDatabase !== undefined)
      await dropPostgresTestDatabase(testDatabase);
  });

  it("starts empty and stores one flat row per fund", async () => {
    expect(await storedRows()).toEqual([]);
    const repository = createLeveragedEtfUniverseRepository(database());
    await expect(
      repository.replaceUniverse(documentOf([FAIL, NOT_MEASURED, PASS]))
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

  it("replaces a changed fund and deletes a fund that left the universe", async () => {
    const repository = createLeveragedEtfUniverseRepository(database());
    const before = (await storedRows()).find((row) => row.symbol === "TQQQ");
    const later = "2026-11-12T15:30:00Z";
    await expect(
      repository.replaceUniverse(
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
          later
        )
      )
    ).resolves.toEqual({ deleted: 1, upserted: 2 });
    const rows = await storedRows();
    expect(rows.map((row) => row.symbol)).toEqual(["AAAZ", "TQQQ"]);
    expect(rows.map((row) => row.generatedAt)).toEqual([
      new Date(later),
      new Date(later),
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
    const repository = createLeveragedEtfUniverseRepository(database());
    await expect(
      repository.replaceUniverse(documentOf([FAIL, NOT_MEASURED, PASS]))
    ).rejects.toThrow(
      new InvalidRepositoryInputError(
        "leveraged ETF universe document generated at 2026-11-11T15:30:00.000Z is older than the stored universe (2026-11-12T15:30:00.000Z)"
      )
    );
    expect(await storedSymbols()).toEqual(["AAAZ", "TQQQ"]);
    await expect(
      repository.replaceUniverse(
        documentOf([FAIL, NOT_MEASURED, PASS], "2026-11-12T15:30:00Z")
      )
    ).resolves.toEqual({ deleted: 0, upserted: 3 });
    expect(await storedSymbols()).toEqual(["AAAZ", "SEMI", "TQQQ"]);
  });

  it("rejects rows that break a check and changes nothing in that transaction", async () => {
    const repository = createLeveragedEtfUniverseRepository(database());
    const at = "2026-11-13T15:30:00Z";
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
      const attempt = repository.replaceUniverse(
        // A valid new fund next to the bad one: neither is stored.
        documentOf([{ ...FAIL, symbol: "ZZZZ" }, fund], at)
      );
      await expect(attempt).rejects.toThrow(InvalidRepositoryInputError);
      await expect(attempt).rejects.toThrow(message);
    }
    await expect(
      repository.replaceUniverse({
        ...documentOf([FAIL], at),
        gate: { ...GATE, maxWindowDays: 4 },
      })
    ).rejects.toThrow(/leveraged_etf_universe_gate_check/u);
    // No ZZZZ row, no deleted row and no newer generated_at.
    const rows = await storedRows();
    expect(rows.map((row) => row.symbol)).toEqual(["AAAZ", "SEMI", "TQQQ"]);
    expect(
      rows.every(
        (row) => row.generatedAt.toISOString() === "2026-11-12T15:30:00.000Z"
      )
    ).toBe(true);
  });

  it("serializes two replaces: the table always ends as the newer document", async () => {
    const repository = createLeveragedEtfUniverseRepository(database());
    const older = documentOf([FAIL, PASS], "2026-11-14T15:30:00Z");
    const newer = documentOf([NOT_MEASURED, PASS], "2026-11-15T15:30:00Z");
    for (let round = 0; round < 5; round += 1) {
      const [first, second] = await Promise.allSettled([
        repository.replaceUniverse(older),
        repository.replaceUniverse(newer),
      ]);
      // The older document is stored first, or refused because the newer one is already stored.
      if (first.status === "rejected")
        expect(first.reason).toBeInstanceOf(InvalidRepositoryInputError);
      expect(second.status).toBe("fulfilled");
      const rows = await storedRows();
      expect(rows.map((row) => row.symbol)).toEqual(["SEMI", "TQQQ"]);
      expect(rows.map((row) => row.generatedAt.toISOString())).toEqual([
        "2026-11-15T15:30:00.000Z",
        "2026-11-15T15:30:00.000Z",
      ]);
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
      const code = await runLeveragedEtfUniverseImport([], {
        env: { DATABASE_URL: testDatabase?.databaseUrl },
        stderr: { write: (line: string) => err.push(line) > 0 },
        stdin: stdin(),
        stdout: { write: (line: string) => out.push(line) > 0 },
      });
      return { code, err, out: out.join("") };
    };
    const first = await importDocument(
      [FAIL, NOT_MEASURED, PASS],
      "2026-11-16T15:30:00Z"
    );
    expect([first.code, first.err]).toEqual([0, []]);
    expect(JSON.parse(first.out)).toEqual({
      deleted: 0,
      fail: 1,
      funds: 3,
      generatedAt: "2026-11-16T15:30:00Z",
      pass: 1,
      "spread-not-measured": 1,
      upserted: 3,
    });
    const second = await importDocument(
      [NOT_MEASURED, PASS],
      "2026-11-17T15:30:00Z"
    );
    expect([second.code, second.err]).toEqual([0, []]);
    expect(JSON.parse(second.out)).toMatchObject({ deleted: 1, upserted: 2 });
    expect(await storedSymbols()).toEqual(["SEMI", "TQQQ"]);
    const stale = await importDocument([FAIL], "2026-11-16T15:30:00Z");
    expect(stale.code).toBe(2);
    expect(stale.err.join("")).toMatch(/is older than the stored universe/u);
    expect(await storedSymbols()).toEqual(["SEMI", "TQQQ"]);
  });

  it("stores exactly what the document schema accepts", async () => {
    const rows = await storedRows();
    expect(rows.map((row) => row.optionGate)).toEqual([
      "spread-not-measured",
      "pass",
    ]);
    // The stored rows rebuild a document that the import schema accepts: same labels, same facts.
    const rebuilt = {
      funds: rows.map((row) => ({
        leverage: row.leverage,
        listingExchange: row.listingExchange,
        name: row.name,
        optionGate: row.optionGate,
        optionGateReasons: row.optionGateReasons,
        options: {
          bandOpenInterest: row.bandOpenInterest,
          halfSpreadPct: row.halfSpreadPct,
          nearestExpiries: row.nearestExpiries,
          quotedAt: row.quotedAt?.toISOString(),
          session: row.quoteSession,
          spot: row.spot,
          totalOpenInterest: row.totalOpenInterest,
          windowExpiry: row.windowExpiry,
        },
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
        minWindowDays: rows[0]?.gateMinWindowDays,
        version: rows[0]?.gateVersion,
      },
      generatedAt: rows[0]?.generatedAt.toISOString(),
      schema: "leveraged-etf-universe-v1",
    };
    expect(LeveragedEtfUniverseDocumentSchema.safeParse(rebuilt).success).toBe(
      true
    );
  });
});
