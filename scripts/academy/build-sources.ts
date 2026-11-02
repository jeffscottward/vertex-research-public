// Builds packages/academy/src/lessons/sources.json from the Define Your Risk knowledge base.
// Usage: bun scripts/academy/build-sources.ts [<kb transcripts dir>]
// Each transcript becomes sentences with start times ESTIMATED from word position over the audio
// duration (the knowledge base stores plain text without segment timestamps). Research data only.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const field = (text: string, label: string): string => {
  const match = new RegExp(`\\*\\*${label}:\\*\\* (.+)`, "u").exec(text);
  return (match?.[1] ?? "").replace(/`/gu, "").trim();
};

// Exact duplicate recorded in the knowledge base notes (normalized text equal).
const DUPLICATES: Readonly<Record<string, string>> = {
  DTlH37JjmfZ: "DTlH5tcDoyh",
};

export type BuildSourcesOptions = Readonly<{
  /** Repository root receiving packages/academy/src/lessons/sources.json. */
  root: string;
  /** Home directory holding the default knowledge-base checkout. */
  home: string;
  stdout: { write: (text: string) => unknown };
}>;

/** Writes sources.json from the transcripts in `args[0]` (or the default knowledge base). */
export const buildSources = (
  args: readonly string[],
  { root, home, stdout }: BuildSourcesOptions
): void => {
  const kb =
    args[0] ??
    join(
      home,
      "Github/knowledge-bases/trading/define-your-risk-instagram/transcripts"
    );
  const out = join(root, "packages/academy/src/lessons/sources.json");

  const sources = readdirSync(kb)
    .filter((name) => /^D.*\.md$/u.test(name))
    .sort()
    .map((name) => {
      const text = readFileSync(join(kb, name), "utf8");
      const id = name.replace(/\.md$/u, "");
      const body = (text.split("## Transcript")[1] ?? "")
        .trim()
        .replace(/\s+/gu, " ");
      const duration =
        Number(field(text, "Audio duration").replace(/ seconds$/u, "")) || 60;
      const sentences =
        body
          .match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/gu)
          ?.map((sentence) => sentence.trim())
          .filter(Boolean) ?? [];
      const total = body.split(" ").filter(Boolean).length || 1;
      let words = 0;
      const transcript = sentences.map((sentence) => {
        const start = Math.round((words / total) * duration * 10) / 10;
        words += sentence.split(" ").filter(Boolean).length;
        return { start, text: sentence };
      });
      return {
        sourceId: id,
        url: field(text, "Canonical URL"),
        caption:
          field(text, "Source caption") ||
          // First line of the note (its title heading).
          text.replace(/\n[\s\S]*/u, "").replace(/^# /u, ""),
        publishedAt: field(text, "Published \\(UTC\\)"),
        durationSeconds: duration,
        transcript,
        ...(DUPLICATES[id] === undefined
          ? {}
          : { duplicateOf: DUPLICATES[id] }),
      };
    });

  writeFileSync(out, `${JSON.stringify(sources, null, 1)}\n`);
  stdout.write(`wrote ${sources.length} sources to ${out}\n`);
};

export type BuildSourcesEntrypoint = Readonly<{
  isMain: boolean | undefined;
  argv: readonly string[];
  options: BuildSourcesOptions;
}>;

/** CLI entry: runs only when this module is the process entry point. */
export const runBuildSourcesEntrypoint = ({
  isMain,
  argv,
  options,
}: BuildSourcesEntrypoint): void => {
  if (!isMain) return;
  buildSources(argv.slice(2), options);
};

runBuildSourcesEntrypoint({
  isMain: import.meta.main,
  argv: process.argv,
  options: {
    root: resolve(import.meta.dirname, "../.."),
    home: homedir(),
    stdout: process.stdout,
  },
});
