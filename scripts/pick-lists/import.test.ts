import { describe, expect, it, vi } from "vitest";

import {
  newYorkDate,
  type PickListImportIo,
  parseTomlWithBun,
  runPickListImport,
} from "./import.ts";

const LISTS_DOCUMENT = JSON.stringify({
  source: "newsletter",
  sourceLabel: "Monthly newsletter",
  lists: [
    {
      slug: "core",
      name: "Core picks",
      asOf: "2026-11-01",
      members: [{ symbol: "aapl", rank: 1 }],
    },
    { slug: "growth", name: "Growth", members: [{ symbol: "MSFT" }] },
  ],
});

const WISHLIST = {
  symbol: [
    { symbol: "META", enabled: true, budget_usd: 5000, note: "dip" },
    { symbol: "LRCX", enabled: false },
  ],
};

const stored = (source: string, slug: string, asOf: string) => ({
  json: {
    id: slug,
    source,
    sourceLabel: "label",
    slug,
    name: slug,
    bucketSymbol: null,
    snapshotCount: 3,
    latest: {
      id: "snap",
      asOf,
      method: "manual",
      importedAt: "2026-11-05T00:00:00.000Z",
      members: [{ symbol: "AAA" }],
    },
  },
});

const env = {
  VERTEX_AGENT_API_KEY: "test-key",
  VERTEX_ORIGIN: "https://vertex.test/path",
};

const harnessFor = (
  argv: readonly string[],
  options: Readonly<{
    env?: Record<string, string | undefined>;
    file?: string;
    respond?: (body: {
      json: { source: string; list: { slug: string }; asOf: string };
    }) => Response;
  }> = {}
) => {
  const out: string[] = [];
  const err: string[] = [];
  const post = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      json: { source: string; list: { slug: string }; asOf: string };
    };
    return (
      options.respond?.(body) ??
      Response.json(
        stored(body.json.source, body.json.list.slug, body.json.asOf)
      )
    );
  });
  const readText = vi.fn(async (path: string) => {
    if (path === "missing.json") throw new Error("ENOENT: missing.json");
    return options.file ?? LISTS_DOCUMENT;
  });
  const parseToml = vi.fn((_text: string): unknown => WISHLIST);
  const io: PickListImportIo = {
    argv,
    env: options.env ?? env,
    post,
    readText,
    parseToml,
    today: () => "2026-11-05",
    stderr: { write: (text: string) => err.push(text) },
    stdout: { write: (text: string) => out.push(text) },
  };
  return { err, io, out, parseToml, post, readText };
};

describe("runPickListImport", () => {
  it("posts each JSON list to pickLists.import with the write key", async () => {
    const harness = harnessFor([
      "--",
      "import",
      "--adapter",
      "json",
      "--file",
      "lists.json",
      "--as-of",
      "2026-11-04",
    ]);
    await expect(runPickListImport(harness.io)).resolves.toBe(0);
    expect(harness.readText).toHaveBeenCalledWith("lists.json");
    expect(harness.post).toHaveBeenCalledTimes(2);
    const [url, init] = harness.post.mock.calls[0] ?? [];
    expect(url).toBe("https://vertex.test/api/orpc/pickLists/import");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      origin: "https://vertex.test",
      "x-api-key": "test-key",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      json: {
        source: "newsletter",
        sourceLabel: "Monthly newsletter",
        list: { slug: "core", name: "Core picks" },
        asOf: "2026-11-01",
        method: "manual",
        members: [{ symbol: "AAPL", rank: 1 }],
      },
    });
    expect(harness.out).toEqual([
      "imported newsletter/core as of 2026-11-01: 1 members (3 snapshots)\n",
      "imported newsletter/growth as of 2026-11-04: 1 members (3 snapshots)\n",
    ]);
    expect(harness.err.join("")).not.toContain("test-key");
  });

  it("imports the wish list dated today unless --as-of is given", async () => {
    const harness = harnessFor([
      "import",
      "--adapter",
      "wishlist",
      "--file",
      "wishlist.toml",
    ]);
    await expect(runPickListImport(harness.io)).resolves.toBe(0);
    expect(harness.parseToml).toHaveBeenCalledWith(LISTS_DOCUMENT);
    const body = JSON.parse(String(harness.post.mock.calls[0]?.[1].body)) as {
      json: unknown;
    };
    expect(body.json).toEqual({
      source: "wishlist",
      sourceLabel: "Owner wish list",
      list: { slug: "wishlist", name: "Wish list" },
      asOf: "2026-11-05",
      method: "manual",
      members: [{ symbol: "META", thesis: "dip" }],
    });
    const dated = harnessFor([
      "import",
      "--adapter=wishlist",
      "--file=wishlist.toml",
      "--as-of=2026-10-31",
    ]);
    await runPickListImport(dated.io);
    expect(dated.out).toEqual([
      "imported wishlist/wishlist as of 2026-10-31: 1 members (3 snapshots)\n",
    ]);
  });

  it("prints the snapshots on --dry-run without credentials or requests", async () => {
    const harness = harnessFor(
      [
        "import",
        "--adapter",
        "json",
        "--file",
        "lists.json",
        "--as-of",
        "2026-11-04",
        "--dry-run",
      ],
      { env: {} }
    );
    await expect(runPickListImport(harness.io)).resolves.toBe(0);
    expect(harness.post).not.toHaveBeenCalled();
    const printed = JSON.parse(harness.out.join("")) as unknown[];
    expect(printed).toHaveLength(2);
    expect(printed[1]).toMatchObject({
      asOf: "2026-11-04",
      list: { slug: "growth" },
    });
  });

  it("rejects bad usage with exit code 2", async () => {
    const cases: [readonly string[], string][] = [
      [[], "the only command is import"],
      [["export"], "the only command is import"],
      [["import", "extra"], "the only command is import"],
      [["import", "--file", "x"], "--adapter is required"],
      [["import", "--adapter", "json"], "--file is required"],
      [["import", "--bogus"], "Unknown option '--bogus'"],
      [
        ["import", "--adapter", "csv", "--file", "x"],
        "--adapter must be one of: json, wishlist",
      ],
    ];
    for (const [argv, message] of cases) {
      const harness = harnessFor(argv);
      await expect(runPickListImport(harness.io)).resolves.toBe(2);
      expect(harness.err.join("")).toContain(message);
      expect(harness.err.join("")).toContain("usage: vertex:pick-lists");
    }
  });

  it("fails with exit code 1 on bad files, missing settings and server errors", async () => {
    const run = async (
      argv: readonly string[],
      options: Parameters<typeof harnessFor>[1] = {}
    ) => {
      const harness = harnessFor(argv, options);
      const code = await runPickListImport(harness.io);
      return { code, err: harness.err.join("") };
    };
    const json = [
      "import",
      "--adapter",
      "json",
      "--file",
      "lists.json",
      "--as-of",
      "2026-11-04",
    ];
    await expect(
      run(["import", "--adapter", "json", "--file", "missing.json"])
    ).resolves.toEqual({
      code: 1,
      err: "pick list import failed: ENOENT: missing.json\n",
    });
    await expect(
      run(json, {
        file: '{"source": "x", "sourceLabel": "X", "lists": []}',
      })
    ).resolves.toEqual({
      code: 1,
      err: "pick list import failed: the file holds no pick lists\n",
    });
    await expect(
      run(json, { env: { VERTEX_ORIGIN: "https://vertex.test" } })
    ).resolves.toEqual({
      code: 1,
      err: "pick list import failed: VERTEX_AGENT_API_KEY is required\n",
    });
    await expect(
      run(json, { env: { VERTEX_AGENT_API_KEY: "k", VERTEX_ORIGIN: " " } })
    ).resolves.toEqual({
      code: 1,
      err: "pick list import failed: VERTEX_ORIGIN is required\n",
    });
    const refused = await run(json, {
      respond: () => new Response("forbidden", { status: 403 }),
    });
    expect(refused).toEqual({
      code: 1,
      err: "pick list import failed: pickLists.import returned HTTP 403 for newsletter/core: forbidden\n",
    });
    const odd = await run(json, { respond: () => Response.json({ json: {} }) });
    expect(odd.code).toBe(1);
    expect(odd.err).toMatch(/^pick list import failed: /u);
  });

  it("reports a thrown non-error value", async () => {
    const harness = harnessFor(["import", "--adapter", "json", "--file", "x"]);
    const io: PickListImportIo = {
      ...harness.io,
      readText: () => Promise.reject("disk gone"),
    };
    await expect(runPickListImport(io)).resolves.toBe(1);
    expect(harness.err).toEqual(["pick list import failed: disk gone\n"]);
  });
});

describe("runtime helpers", () => {
  it("parses TOML with the Bun runtime it is given", () => {
    const parse = vi.fn(() => ({ symbol: [{ symbol: "AAA" }] }));
    expect(parseTomlWithBun("x = 1", { TOML: { parse } })).toEqual({
      symbol: [{ symbol: "AAA" }],
    });
    expect(parse).toHaveBeenCalledWith("x = 1");
  });

  it("refuses to parse TOML without the Bun runtime", () => {
    expect(() => parseTomlWithBun("x = 1", undefined)).toThrow(
      "Reading TOML needs the Bun runtime"
    );
    expect(() => parseTomlWithBun("x = 1", { TOML: null })).toThrow(
      "Reading TOML needs the Bun runtime"
    );
    expect(() => parseTomlWithBun("x = 1", { TOML: {} })).toThrow(
      "Reading TOML needs the Bun runtime"
    );
  });

  it("reads the global Bun runtime by default", () => {
    const hasBun = Reflect.get(globalThis, "Bun") !== undefined;
    if (hasBun) expect(parseTomlWithBun("x = 1")).toEqual({ x: 1 });
    else expect(() => parseTomlWithBun("x = 1")).toThrow("Bun runtime");
  });

  it("dates a moment in New York", () => {
    expect(newYorkDate(new Date("2026-11-05T03:00:00Z"))).toBe("2026-11-04");
    expect(newYorkDate(new Date("2026-11-05T15:00:00Z"))).toBe("2026-11-05");
  });
});
