import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as DbServer from "@darkfactory/db/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseBasketSeeds, runBasketSeed } from "./seed.ts";

const fakes = vi.hoisted(() => {
  const close = vi.fn(async () => undefined);
  return {
    close,
    createBasketRepository: vi.fn(() => ({ fake: "repository" })),
    createNodeDatabase: vi.fn(() => ({ close, db: { fake: true } })),
    findUserIdByEmail: vi.fn(async (): Promise<string | null> => "user-a"),
    seedUserBaskets: vi.fn(async () => ({
      created: ["TITY"],
      skipped: ["UW1Y"],
    })),
  };
});

vi.mock("@darkfactory/db/server", async (importOriginal) => {
  const actual = await importOriginal<typeof DbServer>();
  return {
    createBasketRepository: fakes.createBasketRepository,
    createNodeDatabase: fakes.createNodeDatabase,
    equalBasketWeights: actual.equalBasketWeights,
    findUserIdByEmail: fakes.findUserIdByEmail,
    normalizeBasketSymbol: actual.normalizeBasketSymbol,
    seedUserBaskets: fakes.seedUserBaskets,
    validateBasketMembers: actual.validateBasketMembers,
  };
});

const SEED = JSON.stringify({
  baskets: [
    {
      members: ["vsco", "ESTA", "AVTR"],
      name: " TITY ",
      symbol: "tity",
      weighting: "equal",
    },
  ],
});

let directory = "";
let out: string[] = [];
let err: string[] = [];

const write = (text: string) => {
  const path = join(directory, "seed.json");
  writeFileSync(path, text);
  return path;
};

const runScript = (
  args: string[],
  env: Record<string, string> = {
    DATABASE_URL: "postgresql://test",
    VERTEX_BASKET_OWNER_EMAIL: "owner@example.test",
  }
) =>
  runBasketSeed(args, {
    env,
    stderr: { write: (text: string) => err.push(text) > 0 },
    stdout: { write: (text: string) => out.push(text) > 0 },
  });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "basket-seed-"));
  out = [];
  err = [];
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe("parseBasketSeeds", () => {
  it("normalizes symbols and gives equal weights that sum to 1", () => {
    expect(parseBasketSeeds(SEED)).toEqual([
      {
        members: [
          { symbol: "VSCO", weight: "0.33333334" },
          { symbol: "ESTA", weight: "0.33333333" },
          { symbol: "AVTR", weight: "0.33333333" },
        ],
        name: "TITY",
        symbol: "TITY",
      },
    ]);
  });

  it.each([
    [{ baskets: [] }, "non-empty baskets"],
    [{ baskets: [{ symbol: "bad symbol" }] }, "invalid symbol"],
    [{ baskets: [null] }, "invalid symbol"],
    [{ baskets: [{ symbol: "A", weighting: "equal" }] }, "name is required"],
    [
      { baskets: [{ name: "", symbol: "A", weighting: "equal" }] },
      "name is required",
    ],
    [
      { baskets: [{ name: "A", symbol: "A", weighting: "custom" }] },
      'weighting must be "equal"',
    ],
    [
      {
        baskets: [{ members: [1], name: "A", symbol: "A", weighting: "equal" }],
      },
      "members must be a list",
    ],
    [
      {
        baskets: [{ members: [], name: "A", symbol: "A", weighting: "equal" }],
      },
      "1 to 50 members",
    ],
    [
      {
        baskets: [
          { members: ["X"], name: "A", symbol: "A", weighting: "equal" },
          { members: ["Y"], name: "B", symbol: "a", weighting: "equal" },
        ],
      },
      "duplicate basket symbol: A",
    ],
  ])("rejects %j", (seed, message) => {
    expect(() => parseBasketSeeds(JSON.stringify(seed))).toThrow(message);
  });

  it("accepts the committed owner seed file", () => {
    const seeds = parseBasketSeeds(
      readFileSync(
        new URL("../../research/baskets/owner-baskets.json", import.meta.url),
        "utf8"
      )
    );
    expect(seeds.map((seed) => seed.symbol)).toEqual([
      "TITY",
      "UW10Y",
      "UW5Y",
      "UW2Y",
      "UW1Y",
    ]);
    expect(seeds[0]?.members.map((member) => member.symbol)).toEqual([
      "VSXY",
      "ESTA",
      "AVTR",
    ]);
  });
});

describe("runBasketSeed", () => {
  it("seeds the owner's baskets and closes the database", async () => {
    await expect(runScript([write(SEED)])).resolves.toBe(0);
    expect(fakes.findUserIdByEmail).toHaveBeenCalledWith(
      { fake: true },
      "owner@example.test"
    );
    expect(fakes.seedUserBaskets).toHaveBeenCalledWith(
      { fake: "repository" },
      "user-a",
      parseBasketSeeds(SEED)
    );
    expect(JSON.parse(out.join(""))).toEqual({
      created: ["TITY"],
      skipped: ["UW1Y"],
    });
    expect(fakes.close).toHaveBeenCalledTimes(1);
  });

  it("dry run validates without touching the database", async () => {
    await expect(runScript([write(SEED), "--dry-run"], {})).resolves.toBe(0);
    expect(fakes.createNodeDatabase).not.toHaveBeenCalled();
    expect(JSON.parse(out.join(""))).toEqual({
      baskets: [{ members: 3, symbol: "TITY" }],
      dryRun: true,
    });
  });

  it("fails without a seed path, database URL, email or matching user", async () => {
    await expect(runScript([])).resolves.toBe(1);
    expect(err.join("")).toContain("usage:");
    await expect(
      runScript([write(SEED)], { VERTEX_BASKET_OWNER_EMAIL: "o@example.test" })
    ).resolves.toBe(1);
    expect(err.join("")).toContain("DATABASE_URL is required");
    await expect(
      runScript([write(SEED)], { DATABASE_URL: "postgresql://test" })
    ).resolves.toBe(1);
    expect(err.join("")).toContain("VERTEX_BASKET_OWNER_EMAIL is required");
    fakes.findUserIdByEmail.mockResolvedValueOnce(null);
    await expect(runScript([write(SEED)])).resolves.toBe(1);
    expect(err.join("")).toContain("no user has that email");
    expect(fakes.seedUserBaskets).not.toHaveBeenCalled();
    expect(fakes.close).toHaveBeenCalledTimes(1);
  });

  it("reports a non-Error failure as text and still closes the database", async () => {
    fakes.seedUserBaskets.mockRejectedValueOnce("storage offline");
    await expect(runScript([write(SEED)])).resolves.toBe(1);
    expect(err.join("")).toContain("basket seed failed: storage offline");
    expect(fakes.close).toHaveBeenCalledTimes(1);
  });
});
