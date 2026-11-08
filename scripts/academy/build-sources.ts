// Builds one course's sources file (course-files.ts SOURCES_OUTPUT) from its knowledge base.
// Usage: bun scripts/academy/build-sources.ts [--course <id>] [<kb transcripts dir>]
// The course defaults to dyr (packages/academy/src/lessons/sources.json); database courses get a
// generated TS module under scripts/academy/lessons/<course>, the input of `bun run
// vertex:academy:import` (which can also read the notes directly with --kb). Research data only.
// - dyr: transcripts/D*.md notes. Each transcript becomes sentences with start times ESTIMATED from
//   word position over the audio duration (the notes store plain text without segment timestamps).
// - quantfinancetogo: raw/ig-<post id>.md notes with YAML frontmatter (post_id, url, published,
//   duration, title), a ## Caption text block and ## Transcript segments `- [mm:ss] text`. Segment
//   start times come from the speech-to-text model.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  COURSE_IDS,
  COURSES,
  type CourseId,
  DEFAULT_COURSE_ID,
  isCourseId,
} from "../../packages/academy/src/courses.ts";
import { SOURCES_OUTPUT, sourcesModule } from "./course-files.ts";

const field = (text: string, label: string): string => {
  const match = new RegExp(`\\*\\*${label}:\\*\\* (.+)`, "u").exec(text);
  return (match?.[1] ?? "").replace(/`/gu, "").trim();
};

// Exact duplicate recorded in the knowledge base notes (normalized text equal).
const DUPLICATES: Readonly<Record<string, string>> = {
  DTlH37JjmfZ: "DTlH5tcDoyh",
};

type SourceRecord = Readonly<Record<string, unknown>>;

/** A Define Your Risk transcript note (transcripts/<shortcode>.md). */
const parseDyrNote = (name: string, text: string): SourceRecord => {
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
    ...(DUPLICATES[id] === undefined ? {} : { duplicateOf: DUPLICATES[id] }),
  };
};

/** Flat `key: value` frontmatter; double-quoted values are JSON strings. */
const frontmatter = (text: string): Record<string, string> => {
  const block = /^---\n([\s\S]*?)\n---/u.exec(text)?.[1] ?? "";
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    if (!/^[a-z_]+:/u.test(line)) continue;
    const colon = line.indexOf(":");
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    if (/^".*"$/u.test(value))
      try {
        fields[key] = String(JSON.parse(value));
      } catch {
        fields[key] = value.slice(1, -1);
      }
    else fields[key] = value;
  }
  return fields;
};

/** Text of a `## <heading>` section up to the next level-2 heading. */
const section = (text: string, heading: string): string =>
  (text.split(`\n## ${heading}\n`)[1] ?? "").replace(/\n## [\s\S]*$/u, "");

const SEGMENT = /^- \[(?:(\d+):)?(\d+):(\d{2})\] (.+)$/u;

/** A QuantFinanceToGo reel note (raw/ig-<post id>.md). */
const parseReelNote = (name: string, text: string): SourceRecord => {
  const fields = frontmatter(text);
  const caption = section(text, "Caption")
    .trim()
    .replace(/^```[a-z]*\n/u, "")
    .replace(/\n?```$/u, "")
    .trim();
  const transcript = section(text, "Transcript")
    .split("\n")
    .flatMap((line) => {
      const match = SEGMENT.exec(line.trim());
      if (match === null) return [];
      const [, hours, minutes, seconds, words] = match;
      return [
        {
          start:
            Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds),
          text: String(words).trim(),
        },
      ];
    });
  return {
    course: "quantfinancetogo",
    sourceId:
      fields["post_id"] || name.replace(/^ig-/u, "").replace(/\.md$/u, ""),
    url: fields["url"] ?? "",
    caption: caption || (fields["title"] ?? ""),
    publishedAt: fields["published"] ?? "",
    durationSeconds: Number(fields["duration"]) || 0,
    transcript,
  };
};

type Reader = Readonly<{
  /** Folder below the course's knowledge-base path. */
  dir: string;
  file: RegExp;
  parse: (name: string, text: string) => SourceRecord;
}>;

const READERS: Readonly<Record<CourseId, Reader>> = {
  dyr: { dir: "transcripts", file: /^D.*\.md$/u, parse: parseDyrNote },
  quantfinancetogo: { dir: "raw", file: /^ig-.+\.md$/u, parse: parseReelNote },
};

/** The course's notes folder in the default knowledge-base checkout (~/Github/knowledge-bases). */
export const knowledgeBaseDir = (course: CourseId, home: string): string =>
  join(
    home,
    "Github/knowledge-bases",
    COURSES[course].kbPath,
    READERS[course].dir
  );

/** Every source of the course from its knowledge-base notes folder, in file-name order. */
export const readKnowledgeBaseSources = (
  course: CourseId,
  kb: string
): SourceRecord[] => {
  const reader = READERS[course];
  return readdirSync(kb)
    .filter((name) => reader.file.test(name))
    .sort()
    .map((name) => reader.parse(name, readFileSync(join(kb, name), "utf8")));
};

export type BuildSourcesOptions = Readonly<{
  /** Repository root receiving the course's sources file (course-files.ts). */
  root: string;
  /** Home directory holding the default knowledge-base checkout. */
  home: string;
  stdout: { write: (text: string) => unknown };
}>;

/** Writes the course's sources file from the notes in the directory argument (or its knowledge base). */
export const buildSources = (
  args: readonly string[],
  { root, home, stdout }: BuildSourcesOptions
): void => {
  const courseIndex = args.indexOf("--course");
  const course =
    courseIndex < 0 ? DEFAULT_COURSE_ID : (args[courseIndex + 1] ?? "");
  if (!isCourseId(course))
    throw new Error(
      `unknown course "${course}"; expected one of ${COURSE_IDS.join(", ")}`
    );
  const positional = args.filter(
    (_, index) =>
      courseIndex < 0 || (index !== courseIndex && index !== courseIndex + 1)
  );
  const kb = positional[0] ?? knowledgeBaseDir(course, home);
  const output = SOURCES_OUTPUT[course];
  const out = join(root, output.path);

  const sources = readKnowledgeBaseSources(course, kb);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    output.format === "ts"
      ? sourcesModule(course, sources)
      : `${JSON.stringify(sources, null, 2)}\n`
  );
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
