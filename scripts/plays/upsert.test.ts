import { InvalidRepositoryInputError } from "@darkfactory/db/server";
import { describe, expect, it, vi } from "vitest";
import {
  type CliIo,
  type OpenPlayStore,
  openPlayStore,
  PLAY_INPUT_MAX_BYTES,
  PLAYS_UPSERT_USAGE,
  type PlayStore,
  parsePlayDocument,
  runPlaysUpsert,
} from "./upsert.ts";

// Clearly fake play, as in the dev seeds (docs/plays.md: never commit real plays).
const PLAY = {
  id: "test-play-0001",
  ticker: "ZZZT",
  structure: "call calendar",
  legs: [
    {
      side: "sell",
      right: "call",
      strike: 100,
      expiry: "2099-02-20",
      quantity: 1,
    },
    {
      side: "buy",
      right: "call",
      strike: 100,
      expiry: "2099-05-15",
      quantity: 1,
    },
  ],
  maxLossUsd: 375,
  thesis: "FAKE thesis for tests.",
  trigger: "FAKE trigger.",
  exitRule: "FAKE exit.",
  status: "idea",
  notes: null,
  sourceUrl: "https://example.com/fake",
} as const;
const TEXT = JSON.stringify(PLAY);
const UPDATED_AT = new Date("2026-11-08T12:00:00.000Z");

async function* chunks(...parts: readonly (Uint8Array | string)[]) {
  yield* parts;
}

type CliRun = Readonly<{ err: string[]; io: CliIo; out: string[] }>;

const cli = (
  stdin: AsyncIterable<Uint8Array | string>,
  env: NodeJS.ProcessEnv = { DATABASE_URL: "postgres://plays.test/db" }
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
  upsert: PlayStore["upsert"] = async (input) => ({
    ...input,
    maxLossUsd: String(input.maxLossUsd),
    notes: input.notes ?? null,
    sourceUrl: input.sourceUrl ?? null,
    definedRisk: true,
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
  })
) => {
  const urls: string[] = [];
  const close = vi.fn(async () => undefined);
  const upsertSpy = vi.fn(upsert);
  const open: OpenPlayStore = (url) => {
    urls.push(url);
    return { close, upsert: upsertSpy };
  };
  return { close, open, upsert: upsertSpy, urls };
};

describe("parsePlayDocument", () => {
  it("accepts a play and refuses empty, non-JSON and invalid documents", () => {
    expect(parsePlayDocument(TEXT)).toMatchObject({
      id: "test-play-0001",
      maxLossUsd: 375,
    });
    expect(() => parsePlayDocument("  ")).toThrow("No play document on stdin.");
    expect(() => parsePlayDocument("{")).toThrow(
      "stdin is not one JSON document"
    );
    expect(() =>
      parsePlayDocument(JSON.stringify({ ...PLAY, maxLossUsd: 0 }))
    ).toThrow("The play document is not valid");
    expect(() =>
      parsePlayDocument(JSON.stringify({ ...PLAY, definedRisk: true }))
    ).toThrow("The play document is not valid");
  });
});

describe("runPlaysUpsert", () => {
  it("prints usage for --help", async () => {
    const run = cli(chunks());
    expect(await runPlaysUpsert(["--help"], run.io)).toBe(0);
    expect(run.out.join("")).toBe(`${PLAYS_UPSERT_USAGE}\n`);
  });

  it("prints usage instead of waiting when stdin is a terminal", async () => {
    const run = cli(chunks());
    expect(await runPlaysUpsert([], { ...run.io, stdinIsTTY: true })).toBe(2);
    expect(run.err.join("")).toContain("No play document on stdin.");
  });

  it("checks a document without a database on --dry-run", async () => {
    const store = storeDouble();
    const run = cli(
      chunks(TEXT.slice(0, 10), new TextEncoder().encode(TEXT.slice(10))),
      {}
    );
    expect(await runPlaysUpsert(["--dry-run"], run.io, store.open)).toBe(0);
    expect(JSON.parse(run.out.join(""))).toEqual({
      id: "test-play-0001",
      ticker: "ZZZT",
      dryRun: true,
    });
    expect(store.urls).toEqual([]);
  });

  it("upserts through the store and always closes it", async () => {
    const store = storeDouble();
    const run = cli(chunks(TEXT));
    expect(await runPlaysUpsert([], run.io, store.open)).toBe(0);
    expect(store.urls).toEqual(["postgres://plays.test/db"]);
    expect(store.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: "test-play-0001" })
    );
    expect(JSON.parse(run.out.join(""))).toEqual({
      id: "test-play-0001",
      ticker: "ZZZT",
      maxLossUsd: "375",
      status: "idea",
      updatedAt: "2026-11-08T12:00:00.000Z",
    });
    expect(store.close).toHaveBeenCalledOnce();
  });

  it("exits 2 on usage and input problems without opening the store", async () => {
    const store = storeDouble();
    const cases: [readonly string[], CliRun, string][] = [
      [["--force"], cli(chunks(TEXT)), "Unknown argument --force."],
      [[], cli(chunks(TEXT), {}), "DATABASE_URL is required"],
      [[], cli(chunks(TEXT), { DATABASE_URL: "" }), "DATABASE_URL is required"],
      [
        [],
        cli(chunks("x".repeat(PLAY_INPUT_MAX_BYTES + 1))),
        "stdin is larger than",
      ],
      [
        [],
        cli(chunks(new Uint8Array([0xff, 0xfe]))),
        "stdin is not UTF-8 text",
      ],
    ];
    for (const [argv, run, message] of cases) {
      expect(await runPlaysUpsert(argv, run.io, store.open)).toBe(2);
      expect(run.err.join("")).toContain(message);
    }
    expect(store.urls).toEqual([]);
  });

  it("exits 2 when the repository rejects the play and 1 on other failures", async () => {
    const rejected = storeDouble(async () => {
      throw new InvalidRepositoryInputError("ticker must be a symbol");
    });
    const first = cli(chunks(TEXT));
    expect(await runPlaysUpsert([], first.io, rejected.open)).toBe(2);
    expect(first.err.join("")).toContain("ticker must be a symbol");
    expect(rejected.close).toHaveBeenCalledOnce();

    const broken = storeDouble(async () => {
      throw new Error("socket closed");
    });
    const second = cli(chunks(TEXT));
    expect(await runPlaysUpsert([], second.io, broken.open)).toBe(1);
    expect(second.err.join("")).toBe("play upsert failed: socket closed\n");
    expect(broken.close).toHaveBeenCalledOnce();

    const odd = storeDouble(async () => {
      throw "down";
    });
    const third = cli(chunks(TEXT));
    expect(await runPlaysUpsert([], third.io, odd.open)).toBe(1);
    expect(third.err.join("")).toBe("play upsert failed: down\n");
  });

  it("checks the repository rules on --dry-run: naked shorts and bad tickers exit 2", async () => {
    const naked = cli(
      chunks(JSON.stringify({ ...PLAY, legs: [PLAY.legs[0]] })),
      {}
    );
    expect(await runPlaysUpsert(["--dry-run"], naked.io)).toBe(2);
    expect(naked.err.join("")).toContain("short call legs must be covered");
    const ticker = cli(
      chunks(JSON.stringify({ ...PLAY, ticker: "zz zt" })),
      {}
    );
    expect(await runPlaysUpsert(["--dry-run"], ticker.io)).toBe(2);
    expect(ticker.err.join("")).toContain("ticker must be a symbol");
  });

  it("reports a failed close as a warning without hiding the result", async () => {
    const store = storeDouble();
    store.close.mockRejectedValueOnce(new Error("pool ended"));
    const ok = cli(chunks(TEXT));
    expect(await runPlaysUpsert([], ok.io, store.open)).toBe(0);
    expect(ok.err.join("")).toBe(
      "warning: closing the database connection failed: pool ended\n"
    );
    const broken = storeDouble(async () => {
      throw new Error("socket closed");
    });
    broken.close.mockRejectedValueOnce("closed twice");
    const failed = cli(chunks(TEXT));
    expect(await runPlaysUpsert([], failed.io, broken.open)).toBe(1);
    expect(failed.err.join("")).toBe(
      "warning: closing the database connection failed: closed twice\nplay upsert failed: socket closed\n"
    );
  });

  it("reports a stdin read failure as a failure, not as bad UTF-8", async () => {
    async function* failing(): AsyncGenerator<string> {
      yield "{";
      throw new Error("read EIO");
    }
    const run = cli(failing());
    expect(await runPlaysUpsert([], run.io)).toBe(1);
    expect(run.err.join("")).toBe("play upsert failed: read EIO\n");
  });

  it("opens a real store lazily: the default opener connects only on use", async () => {
    const store = openPlayStore("postgresql://nobody:nothing@127.0.0.1:1/none");
    await expect(
      store.upsert({ ...PLAY, legs: [...PLAY.legs], status: "idea" })
    ).rejects.toThrow();
    await store.close();
  });
});
