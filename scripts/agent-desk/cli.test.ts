import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

import { parseArgs, runAgentDeskCli, writeJsonAtomic } from "./cli.ts";
import {
  bars,
  dateAt,
  signalCloses,
  writeStore,
} from "./fixtures.test-support.ts";

const history = bars(signalCloses());
const signalDate = dateAt(history.length - 1);
let root: string;
let data: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-desk-cli-"));
  data = writeStore(root, history);
});
afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

const cli = async (argv: string[], now = new Date("2026-10-18T12:00:00Z")) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAgentDeskCli(argv, {
    now,
    root,
    stderr: { write: (text: string) => err.push(text) },
    stdout: { write: (text: string) => out.push(text) },
  });
  return { code, err: err.join(""), out: out.join("") };
};
const common = () => ["--data-root", data, "--tickers", "AAA,BBB"];
const deskDir = () => join(root, "private", "agent-desk");

describe("parseArgs", () => {
  it("rejects malformed arguments", () => {
    const parse = (argv: string[]) => () => parseArgs(argv, root, "2026-10-18");
    expect(parse(["--data-root", data])).toThrow(
      "--tickers needs 1-10 report IDs"
    );
    expect(
      parse(["--data-root", data, "--tickers", "A,B,C,D,E,F,G,H,I,J,K"])
    ).toThrow("--tickers needs 1-10 report IDs");
    expect(parse(["--data-root", data, "--tickers", "AAPL,aapl"])).toThrow(
      "--tickers contains duplicates"
    );
    expect(
      parse(["--data-root", data, "--tickers", "AAPL", "--as-of", "2026-02-31"])
    ).toThrow("--as-of must be a real YYYY-MM-DD date");
    expect(parse(["--tickers", "AAPL"])).toThrow("--data-root is required");
    expect(parse(["--tickers", "AAPL", "--live"])).toThrow(
      "Unknown argument --live"
    );
    expect(parse(["--tickers", "AAPL", "--write=false"])).toThrow(
      "Unknown argument --write=false"
    );
    expect(parse(["--tickers", "AAPL", "--tickers", "MSFT"])).toThrow(
      "Argument --tickers is repeated"
    );
    expect(parse(["--tickers"])).toThrow("--tickers needs a value");
    expect(parse(["--tickers", "--write"])).toThrow("--tickers needs a value");
    expect(parse(["--tickers="])).toThrow("--tickers needs a value");
  });

  it("applies the private default paths and today's date", () => {
    expect(
      parseArgs(
        [`--data-root=${data}`, "--tickers=aapl, nvda", "--json"],
        root,
        "2026-10-18"
      )
    ).toEqual({
      asOf: "2026-10-18",
      book: join(root, "private", "agent-desk", "paper-book.json"),
      dataRoot: data,
      json: true,
      sentimentDir: join(root, "private", "agent-desk", "sentiment"),
      tickers: ["AAPL", "NVDA"],
      write: false,
    });
  });
});

describe("runAgentDeskCli", () => {
  it("prints a dry run and saves nothing", async () => {
    const result = await cli([...common(), "--as-of", signalDate]);
    expect(result).toMatchObject({ code: 0, err: "" });
    expect(result.out).toContain("AAA: paper-open");
    expect(result.out).toContain("Dry run: nothing saved.");
    expect(existsSync(deskDir())).toBe(false);
    const json = await cli([...common(), "--as-of", signalDate, "--json"]);
    expect(JSON.parse(json.out.split("\nDry run")[0] as string)).toMatchObject({
      mode: "paper",
      orders: "none",
    });
  });

  it("saves the journal privately and refuses earlier or future dates", async () => {
    const saved = await cli(
      [...common(), "--as-of", signalDate, "--write"],
      new Date("2026-10-18T00:00:00Z")
    );
    expect(saved).toMatchObject({ code: 0, err: "" });
    expect(saved.out).toContain(
      `Saved paper book ${join(deskDir(), "paper-book.json")}`
    );
    const book = JSON.parse(
      readFileSync(join(deskDir(), "paper-book.json"), "utf8")
    );
    expect(book).toMatchObject({
      lastRunAsOf: signalDate,
      mode: "paper",
      positions: [{ reportId: "AAA", status: "pending-entry" }],
    });
    expect(readdirSync(deskDir()).sort()).toEqual(["paper-book.json", "runs"]);
    expect(readdirSync(join(deskDir(), "runs"))).toEqual([
      `${signalDate}.json`,
    ]);
    expect(statSync(join(deskDir(), "paper-book.json")).mode & 0o777).toBe(
      0o600
    );
    expect(statSync(deskDir()).mode & 0o777).toBe(0o700);

    const earlier = await cli([...common(), "--as-of", dateAt(10), "--write"]);
    expect(earlier).toMatchObject({
      code: 1,
      err: `agent-desk: TypeError: Paper book already ran for ${signalDate}; refusing to save an earlier date ${dateAt(10)}\n`,
    });
    const future = await cli([...common(), "--as-of", "2026-10-19", "--write"]);
    expect(future.err).toContain("after today 2026-10-18");
    expect(readdirSync(deskDir()).sort()).toEqual(["paper-book.json", "runs"]);
  });

  it("refuses a second concurrent writer and reports unreadable books", async () => {
    mkdirSync(deskDir(), { recursive: true });
    writeFileSync(join(deskDir(), "paper-book.json.lock"), "");
    expect(
      (await cli([...common(), "--as-of", signalDate, "--write"])).err
    ).toContain("Another desk run holds");
    rmSync(join(deskDir(), "paper-book.json.lock"));
    mkdirSync(join(deskDir(), "paper-book.json"));
    expect((await cli([...common(), "--as-of", signalDate])).err).toContain(
      "EISDIR"
    );
    rmSync(join(deskDir(), "paper-book.json"), { recursive: true });
    vi.mocked(open).mockRejectedValueOnce(
      Object.assign(new Error("EIO: synthetic i/o error"), { code: "EIO" })
    );
    expect(
      (await cli([...common(), "--as-of", signalDate, "--write"])).err
    ).toContain("EIO: synthetic i/o error");
  });
});

describe("writeJsonAtomic", () => {
  it("removes its temporary file when the rename fails", async () => {
    const target = join(root, "out", "book.json");
    mkdirSync(target, { recursive: true });
    await expect(writeJsonAtomic(target, { a: 1 })).rejects.toThrow();
    expect(readdirSync(join(root, "out"))).toEqual(["book.json"]);
  });
});
