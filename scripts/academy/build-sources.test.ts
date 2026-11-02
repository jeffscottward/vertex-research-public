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
