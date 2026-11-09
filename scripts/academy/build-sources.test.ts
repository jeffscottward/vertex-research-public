import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type BuildSourcesOptions,
  buildSources,
  knowledgeBaseDir,
  knowledgeBaseRoot,
  readKnowledgeBaseSources,
  runBuildSourcesEntrypoint,
} from "./build-sources.ts";

const DEFAULT_KB =
  "Github/knowledge-bases/trading/define-your-risk-instagram/transcripts";

let root: string;
let home: string;
let stdout: string[];

const options = (): BuildSourcesOptions => ({
  home,
  root,
  stdout: { write: (text: string) => stdout.push(text) },
});
const outPath = () => join(root, "packages/academy/src/lessons/sources.json");
const readOut = () => JSON.parse(readFileSync(outPath(), "utf8")) as unknown;

const note = (lines: readonly string[]) => `${lines.join("\n")}\n`;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "academy-sources-"));
  root = join(base, "repo");
  home = join(base, "home");
  mkdirSync(join(root, "packages/academy/src/lessons"), { recursive: true });
  stdout = [];
});

afterEach(() => {
  rmSync(join(root, ".."), { force: true, recursive: true });
});

describe("buildSources", () => {
  it("parses transcripts from the given knowledge-base directory", () => {
    const kb = join(root, "..", "kb");
    mkdirSync(kb);
    writeFileSync(
      join(kb, "DAbc.md"),
      note([
        "# Ignored title",
        "",
        "- **Canonical URL:** `https://www.instagram.com/reel/DAbc/`",
        "- **Source caption:**  Covered calls explained ",
        "- **Published (UTC):** 2026-01-02T03:04:05Z",
        "- **Audio duration:** 20 seconds",
        "",
        "## Transcript",
        "",
        "One two three four.   Five six",
        'seven eight! "Quoted end?") trailing words',
      ])
    );
    // The knowledge base records this note as an exact duplicate of another source.
    writeFileSync(
      join(kb, "DTlH37JjmfZ.md"),
      note(["# Duplicate reel", "", "## Transcript", "", "Same text."])
    );
    writeFileSync(join(kb, "README.md"), "not a transcript");
    writeFileSync(join(kb, "DNotes.txt"), "not markdown");

    buildSources([kb], options());

    expect(readFileSync(outPath(), "utf8").endsWith("]\n")).toBe(true);
    expect(readOut()).toEqual([
      {
        caption: "Covered calls explained",
        durationSeconds: 20,
        publishedAt: "2026-01-02T03:04:05Z",
        sourceId: "DAbc",
        transcript: [
          { start: 0, text: "One two three four." },
          { start: 6.7, text: "Five six seven eight!" },
          { start: 13.3, text: '"Quoted end?")' },
          { start: 16.7, text: "trailing words" },
        ],
        url: "https://www.instagram.com/reel/DAbc/",
      },
      {
        caption: "Duplicate reel",
        duplicateOf: "DTlH5tcDoyh",
        durationSeconds: 60,
        publishedAt: "",
        sourceId: "DTlH37JjmfZ",
        transcript: [{ start: 0, text: "Same text." }],
        url: "",
      },
    ]);
    expect(stdout).toEqual([`wrote 2 sources to ${outPath()}\n`]);
  });

  it("reads the default knowledge base and tolerates notes without a transcript", () => {
    const kb = join(home, DEFAULT_KB);
    mkdirSync(kb, { recursive: true });
    writeFileSync(join(kb, "DEmpty.md"), "# Title only");
    writeFileSync(
      join(kb, "DBlank.md"),
      note(["", "**Audio duration:** unknown", "## Transcript", "   "])
    );

    buildSources([], options());

    expect(readOut()).toEqual([
      {
        caption: "",
        durationSeconds: 60,
        publishedAt: "",
        sourceId: "DBlank",
        transcript: [],
        url: "",
      },
      {
        caption: "Title only",
        durationSeconds: 60,
        publishedAt: "",
        sourceId: "DEmpty",
        transcript: [],
        url: "",
      },
    ]);
  });
});

const QFTG_KB = "Github/knowledge-bases/trading/quantfinancetogo/raw";
describe("readKnowledgeBaseSources (quantfinancetogo)", () => {
  it("reads reel notes: frontmatter, caption block and timestamped segments", () => {
    const kb = join(home, QFTG_KB);
    mkdirSync(kb, { recursive: true });
    writeFileSync(
      join(kb, "ig-Df_Ab-12345.md"),
      note([
        "---",
        "type: raw-transcript",
        'title: "Part 37: \\"Binomial\\" pricing"',
        "platform: instagram",
        'post_id: "Df_Ab-12345"',
        "url: https://www.instagram.com/reel/Df_Ab-12345/",
        "published: 2026-10-31",
        "duration: 118.0",
        'transcript_status: "ok"',
        "topics: [options-pricing]",
        "  indented: ignored",
        "---",
        "",
        "# Part 37",
        "",
        "## Caption",
        "",
        "```text",
        "Part 37: Binomial model option pricing",
        "",
        "Education only, not financial advice.",
        "```",
        "",
        "## Transcript",
        "",
        "- [00:00] In 1979, three researchers",
        "- [01:03] the real chance   ",
        "- [1:02:05] an hour in",
        "not a segment",
      ])
    );
    // A no-speech reel: no caption, no url, no post id, invalid quoted title.
    writeFileSync(
      join(kb, "ig-Dq9.md"),
      note([
        "---",
        'title: "broken \\q escape"',
        "duration: none",
        "---",
        "",
        "## Transcript",
        "",
        "No speech transcript (no-speech).",
      ])
    );
    // Neither caption nor title.
    writeFileSync(join(kb, "ig-Dzz.md"), note(["# Only a heading"]));
    writeFileSync(join(kb, "index.md"), "---\ntype: index\n---\n");

    expect(
      readKnowledgeBaseSources(
        "quantfinancetogo",
        knowledgeBaseDir("quantfinancetogo", home)
      )
    ).toEqual([
      {
        caption:
          "Part 37: Binomial model option pricing\n\nEducation only, not financial advice.",
        course: "quantfinancetogo",
        durationSeconds: 118,
        publishedAt: "2026-10-31",
        sourceId: "Df_Ab-12345",
        transcript: [
          { start: 0, text: "In 1979, three researchers" },
          { start: 63, text: "the real chance" },
          { start: 3725, text: "an hour in" },
        ],
        url: "https://www.instagram.com/reel/Df_Ab-12345/",
      },
      {
        caption: "broken \\q escape",
        course: "quantfinancetogo",
        durationSeconds: 0,
        publishedAt: "",
        sourceId: "Dq9",
        transcript: [],
        url: "",
      },
      {
        caption: "",
        course: "quantfinancetogo",
        durationSeconds: 0,
        publishedAt: "",
        sourceId: "Dzz",
        transcript: [],
        url: "",
      },
    ]);
  });

  it("keeps the frontmatter title when it is valid JSON", () => {
    const kb = join(root, "..", "reels");
    mkdirSync(kb);
    writeFileSync(
      join(kb, "ig-Dt1.md"),
      note(["---", 'title: "Quoted \\"title\\""', "---"])
    );
    expect(readKnowledgeBaseSources("quantfinancetogo", kb)).toEqual([
      expect.objectContaining({ caption: 'Quoted "title"', sourceId: "Dt1" }),
    ]);
  });

  it("finds the knowledge base in ~/Github/knowledge-bases or $ACADEMY_KB_ROOT", () => {
    expect(knowledgeBaseRoot(home)).toBe(join(home, "Github/knowledge-bases"));
    expect(knowledgeBaseRoot(home, { ACADEMY_KB_ROOT: "  " })).toBe(
      join(home, "Github/knowledge-bases")
    );
    expect(knowledgeBaseRoot(home, { ACADEMY_KB_ROOT: "/srv/kb" })).toBe(
      "/srv/kb"
    );
    expect(knowledgeBaseDir("quantfinancetogo", home, "/srv/kb")).toBe(
      "/srv/kb/trading/quantfinancetogo/raw"
    );
  });
});

describe("buildSources --course quantfinancetogo", () => {
  it("writes nothing: a database course's sources stay in the knowledge base", () => {
    const kb = join(home, QFTG_KB);
    mkdirSync(kb, { recursive: true });
    writeFileSync(join(kb, "ig-Dt1.md"), note(["---", "title: x", "---"]));
    expect(() =>
      buildSources(["--course", "quantfinancetogo"], options())
    ).toThrow(
      "course quantfinancetogo keeps its sources in the knowledge base, not in the repository"
    );
    expect(stdout).toEqual([]);
    expect(existsSync(join(root, "scripts"))).toBe(false);
  });

  it("refuses an unknown or missing course", () => {
    expect(() => buildSources(["--course", "nope"], options())).toThrow(
      'unknown course "nope"; expected one of dyr, quantfinancetogo'
    );
    expect(() => buildSources(["--course"], options())).toThrow(
      'unknown course ""'
    );
  });
});

describe("runBuildSourcesEntrypoint", () => {
  it("does nothing when imported", () => {
    runBuildSourcesEntrypoint({
      argv: ["bun", "build-sources.ts"],
      isMain: undefined,
      options: options(),
    });
    runBuildSourcesEntrypoint({
      argv: ["bun", "build-sources.ts"],
      isMain: false,
      options: options(),
    });
    expect(existsSync(outPath())).toBe(false);
    expect(import.meta.main).toBeFalsy();
  });

  it("passes the directory argument after the runtime and script", () => {
    const kb = join(root, "..", "custom");
    mkdirSync(kb);
    writeFileSync(join(kb, "DOne.md"), note(["# One", "## Transcript", "Hi."]));
    runBuildSourcesEntrypoint({
      argv: ["bun", "scripts/academy/build-sources.ts", kb],
      isMain: true,
      options: options(),
    });
    expect(readOut()).toEqual([
      {
        caption: "One",
        durationSeconds: 60,
        publishedAt: "",
        sourceId: "DOne",
        transcript: [{ start: 0, text: "Hi." }],
        url: "",
      },
    ]);
  });
});
