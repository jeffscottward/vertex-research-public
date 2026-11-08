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
  runBuildSourcesEntrypoint,
} from "./build-sources.ts";

const DEFAULT_KB =
  "Github/knowledge-bases/trading/define-your-risk-instagram/transcripts";

let root: string;
let home: string;
let stdout: string[];

const options = (): BuildSourcesOptions => ({
  root,
  home,
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
  rmSync(join(root, ".."), { recursive: true, force: true });
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
        sourceId: "DAbc",
        url: "https://www.instagram.com/reel/DAbc/",
        caption: "Covered calls explained",
        publishedAt: "2026-01-02T03:04:05Z",
        durationSeconds: 20,
        transcript: [
          { start: 0, text: "One two three four." },
          { start: 6.7, text: "Five six seven eight!" },
          { start: 13.3, text: '"Quoted end?")' },
          { start: 16.7, text: "trailing words" },
        ],
      },
      {
        sourceId: "DTlH37JjmfZ",
        url: "",
        caption: "Duplicate reel",
        publishedAt: "",
        durationSeconds: 60,
        transcript: [{ start: 0, text: "Same text." }],
        duplicateOf: "DTlH5tcDoyh",
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
        sourceId: "DBlank",
        url: "",
        caption: "",
        publishedAt: "",
        durationSeconds: 60,
        transcript: [],
      },
      {
        sourceId: "DEmpty",
        url: "",
        caption: "Title only",
        publishedAt: "",
        durationSeconds: 60,
        transcript: [],
      },
    ]);
  });
});

const QFTG_KB = "Github/knowledge-bases/trading/quantfinancetogo/raw";
const qftgOut = () =>
  join(root, "packages/academy/src/lessons/sources.quantfinancetogo.json");
const readQftg = () => JSON.parse(readFileSync(qftgOut(), "utf8")) as unknown;

describe("buildSources --course quantfinancetogo", () => {
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

    buildSources(["--course", "quantfinancetogo"], options());

    expect(
      readFileSync(qftgOut(), "utf8").startsWith('[\n  {\n    "course"')
    ).toBe(true);
    expect(readQftg()).toEqual([
      {
        course: "quantfinancetogo",
        sourceId: "Df_Ab-12345",
        url: "https://www.instagram.com/reel/Df_Ab-12345/",
        caption:
          "Part 37: Binomial model option pricing\n\nEducation only, not financial advice.",
        publishedAt: "2026-10-31",
        durationSeconds: 118,
        transcript: [
          { start: 0, text: "In 1979, three researchers" },
          { start: 63, text: "the real chance" },
          { start: 3725, text: "an hour in" },
        ],
      },
      {
        course: "quantfinancetogo",
        sourceId: "Dq9",
        url: "",
        caption: "broken \\q escape",
        publishedAt: "",
        durationSeconds: 0,
        transcript: [],
      },
      {
        course: "quantfinancetogo",
        sourceId: "Dzz",
        url: "",
        caption: "",
        publishedAt: "",
        durationSeconds: 0,
        transcript: [],
      },
    ]);
    expect(stdout).toEqual([`wrote 3 sources to ${qftgOut()}\n`]);
    // The Define Your Risk sources file is untouched.
    expect(existsSync(outPath())).toBe(false);
  });

  it("keeps the frontmatter title when it is valid JSON and takes a directory after the course", () => {
    const kb = join(root, "..", "reels");
    mkdirSync(kb);
    writeFileSync(
      join(kb, "ig-Dt1.md"),
      note(["---", 'title: "Quoted \\"title\\""', "---"])
    );
    buildSources([kb, "--course", "quantfinancetogo"], options());
    expect(readQftg()).toEqual([
      expect.objectContaining({ sourceId: "Dt1", caption: 'Quoted "title"' }),
    ]);
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
      isMain: undefined,
      argv: ["bun", "build-sources.ts"],
      options: options(),
    });
    runBuildSourcesEntrypoint({
      isMain: false,
      argv: ["bun", "build-sources.ts"],
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
      isMain: true,
      argv: ["bun", "scripts/academy/build-sources.ts", kb],
      options: options(),
    });
    expect(readOut()).toEqual([
      {
        sourceId: "DOne",
        url: "",
        caption: "One",
        publishedAt: "",
        durationSeconds: 60,
        transcript: [{ start: 0, text: "Hi." }],
      },
    ]);
  });
});
