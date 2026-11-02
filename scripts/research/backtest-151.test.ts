import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildCsv,
  buildIndex,
  autolink,
  buildUniverse,
  csvField,
  loadSources,
  RESEARCH_DIR,
  renderFiles,
  runBacktest151Cli,
  type StrategiesDoc,
  type Universe,
} from "./backtest-151.ts";

const repoRoot = join(import.meta.dirname, "..", "..");

const strategy = (
  overrides: Partial<StrategiesDoc["strategies"][number]>
): StrategiesDoc["strategies"][number] => ({
  section: "1.1",
  name: "Price momentum",
  name_es: "Momento",
  chapter: 1,
  asset_class: "Stocks",
  is_variant: false,
  rule_summary: "Buy winners | sell losers\nmonthly",
  instruments: ["stocks"],
  required_data: ["daily close prices", "volume"],
  frequency: "monthly",
  paper_backtestable: "yes",
  backtest_note: 'Uses "close", not open',
  wave: 1,
  harness_primary: "nautilus",
  nautilus_fit: "native",
  roboquant_fit: "none",
  data_sources: ["IBKR history"],
  gaps: [],
  universe_groups: ["g1"],
  ...overrides,
});

const fixtureDoc: StrategiesDoc = {
  source: {
    title: "151 Trading Strategies",
    authors: ["A", "B"],
    ssrn: "https://example.test/ssrn",
    text_used: "arXiv text",
    english_names: "table of contents (https://example.test/toc.pdf)",
  },
  count: 4,
  strategies: [
    strategy({}),
    strategy({ section: "1.1.1", name: "Variant", is_variant: true }),
    strategy({ section: "1.2", name: "F* = S·e" }),
    strategy({
      section: "2.1",
      chapter: 2,
      asset_class: "Futures",
      roboquant_fit: "cme-futures",
      wave: 2,
    }),
  ],
};

const fixtureUniverse: Universe = {
  as_of: "2026-10-16",
  swinglytics_snapshot: "2026-10-16T00:00:00Z",
  note: "Fixture universe.",
  groups: [
    {
      id: "g1",
      name: "Group | one",
      profile: "large caps",
      source: "fixture",
      etfs: ["SPY", "RSP"],
      stocks: [],
      strategies: ["1.1", "9.9"],
    },
    {
      id: "g2",
      name: "Empty",
      profile: "none",
      source: "fixture",
      strategies: [],
    },
  ],
};

describe("csv output", () => {
  it("quotes only fields that need it", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a, b")).toBe('"a, b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });

  it("writes a header and joins list fields", () => {
    const csv = buildCsv(fixtureDoc);
    expect(csv).toMatch(/^section,name,asset_class,is_variant,/u);
    expect(csv).toContain(
      "\n1.1,Price momentum,Stocks,false,monthly,1,nautilus,native,none,yes,stocks,daily close prices; volume,IBKR history,,g1,"
    );
    expect(csv).toContain(
      '"Buy winners | sell losers\nmonthly","Uses ""close"", not open",Momento\n'
    );
    expect(csv).toContain("\n1.1.1,Variant,Stocks,true,");
    expect(csv.endsWith("\n")).toBe(true);
  });
});

describe("markdown output", () => {
  it("starts a compact table per chapter and marks variants and roboquant fits", () => {
    const index = buildIndex(fixtureDoc);
    expect(index).toContain("Source: 151 Trading Strategies, A and B.");
    expect(index).toContain(
      "table of contents (<https://example.test/toc.pdf>)."
    );
    expect(
      autolink("<https://a.test> [x](https://b.test) https://c.test")
    ).toBe("<https://a.test> [x](https://b.test) <https://c.test>");
    expect(index).toContain("|1.2|F\\* = S·e|");
    expect(index).toContain("## 1. Stocks");
    expect(index).toContain("## 2. Futures");
    expect(index).toContain(
      "|1.1|Price momentum|monthly|1|nautilus||Buy winners \\| sell losers monthly|"
    );
    expect(index).toContain("|1.1.1|↳ Variant|");
    expect(index).toContain("|2.1|Price momentum|monthly|2|nautilus|yes|");
    expect(index).not.toMatch(/\n\n\n/u);
  });

  it("lists group members and strategies, with fallbacks for gaps", () => {
    const universe = buildUniverse(fixtureUniverse, fixtureDoc);
    expect(universe).toContain(
      "|g1|Group \\| one|large caps|fixture|ETF: SPY, RSP|2|"
    );
    expect(universe).toContain("|g2|Empty|none|fixture||0|");
    expect(universe).toContain(
      "- **g1 Group | one**: 1.1 Price momentum, 9.9 (unknown)"
    );
    expect(universe).toContain("- **g2 Empty**: none");
  });
});

describe("cli", () => {
  let root: string;
  let dir: string;
  const out: string[] = [];
  const err: string[] = [];
  const io = (): Parameters<typeof runBacktest151Cli>[1] => ({
    root,
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "backtest-151-"));
    dir = join(root, RESEARCH_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "strategies.json"), JSON.stringify(fixtureDoc));
    writeFileSync(join(dir, "universe.json"), JSON.stringify(fixtureUniverse));
    out.length = 0;
    err.length = 0;
  });
  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it("rejects unknown arguments", async () => {
    expect(await runBacktest151Cli(["--force"], io())).toBe(2);
    expect(err.join("")).toBe("unknown argument: --force\n");
  });

  it("reports missing and stale files in check mode", async () => {
    expect(await runBacktest151Cli(["--check"], io())).toBe(1);
    expect(err.join("")).toBe(
      "out of date: strategies.csv, index.md, universe.md\n"
    );
  });

  it("writes the files, then passes the check", async () => {
    expect(await runBacktest151Cli([], io())).toBe(0);
    expect(out.join("")).toBe("wrote strategies.csv, index.md, universe.md\n");
    expect(readFileSync(join(dir, "index.md"), "utf8")).toBe(
      buildIndex(fixtureDoc)
    );
    writeFileSync(join(dir, "universe.md"), "edited by hand\n");
    expect(await runBacktest151Cli(["--check"], io())).toBe(1);
    expect(err.join("")).toBe("out of date: universe.md\n");
    expect(await runBacktest151Cli([], io())).toBe(0);
    expect(await runBacktest151Cli(["--check"], io())).toBe(0);
    expect(out.at(-1)).toBe("ok\n");
  });
});

// Ported from PR #4 tests/backtest-151-strategies.test.mjs: structure and cross-references of the
// committed research files.
const dir = join(repoRoot, RESEARCH_DIR);
const { doc, universe } = await loadSources(dir);
const snapshot = z
  .object({
    generated_at: z.string(),
    sectors: z.array(z.object({ etf: z.string() })),
    themes: z.array(
      z.object({ name: z.string(), tickers: z.array(z.string()) })
    ),
  })
  .parse(
    JSON.parse(readFileSync(join(dir, "swinglytics-snapshot.json"), "utf8"))
  );
const bySection = new Map(doc.strategies.map((s) => [s.section, s]));
const groups = new Map(universe.groups.map((g) => [g.id, g]));

describe("committed research files", () => {
  it("generated files are up to date", () => {
    for (const [name, text] of Object.entries(renderFiles(doc, universe))) {
      expect(readFileSync(join(dir, name), "utf8"), name).toBe(text);
    }
  });

  it("every strategy has a unique section and the required fields", () => {
    expect(doc.count).toBe(doc.strategies.length);
    expect(bySection.size, "duplicate section").toBe(doc.strategies.length);
    for (const s of doc.strategies) {
      expect(s.chapter, `${s.section}: chapter`).toBe(
        Number(s.section.split(".")[0])
      );
      expect(s.is_variant, `${s.section}: is_variant`).toBe(
        s.section.split(".").length === 3
      );
    }
  });

  it("mapping values use the documented enums and agree with each other", () => {
    for (const s of doc.strategies) {
      expect([0, 1, 2, 3], `${s.section}: wave`).toContain(s.wave);
      expect(["nautilus", "nautilus-proxy", "none"]).toContain(
        s.harness_primary
      );
      expect(["native", "custom-data", "proxy-or-model", "none"]).toContain(
        s.nautilus_fit
      );
      expect(["cme-futures", "none"]).toContain(s.roboquant_fit);
      expect(s.wave === 0, `${s.section}: wave 0 means no harness`).toBe(
        s.harness_primary === "none"
      );
      if (s.wave > 0) {
        expect(
          s.data_sources.length,
          `${s.section}: data source`
        ).toBeGreaterThan(0);
      }
      if (s.wave !== 1) {
        expect(
          s.gaps.length,
          `${s.section}: gap outside wave 1`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("the excluded illegal entries are never backtested", () => {
    for (const section of ["17.2", "17.6"]) {
      expect(bySection.get(section)?.wave, section).toBe(0);
    }
  });

  it("universe has 20 groups and cross-references resolve both ways", () => {
    expect(groups.size).toBe(20);
    for (const s of doc.strategies) {
      for (const id of s.universe_groups) {
        expect(groups.has(id), `${s.section}: unknown group ${id}`).toBe(true);
      }
    }
    for (const g of universe.groups) {
      expect(g.strategies.length, `${g.id}: no strategies`).toBeGreaterThan(0);
      for (const section of g.strategies) {
        expect(
          bySection.get(section)?.universe_groups,
          `${g.id}: ${section} not mapped back`
        ).toContain(g.id);
      }
    }
  });

  it("every Swinglytics sector ETF and theme ticker is in the universe", () => {
    const members = new Set(
      universe.groups.flatMap((g) => [
        ...(g.etfs ?? []),
        ...(g.stocks ?? []),
        ...(g.crypto ?? []),
      ])
    );
    for (const sector of snapshot.sectors) {
      expect(members.has(sector.etf), `sector ${sector.etf}`).toBe(true);
    }
    for (const theme of snapshot.themes) {
      for (const ticker of theme.tickers) {
        expect(members.has(ticker), `${theme.name}: ${ticker}`).toBe(true);
      }
    }
    expect(universe.swinglytics_snapshot).toBe(snapshot.generated_at);
  });
});
