import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  RESEARCH_PAPER_KINDS,
  RESEARCH_PAPER_STAGES,
  RESEARCH_PAPER_VERDICTS,
} from "./schema/index.ts";

// Data migration 0103: three learning links from reel DfDt0GDR8Oa
// (card vertex-repos-reel-library-links; docs/vertex-rebuild/upstream-candidates-20261030.md).
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const TAG = "0103_research_papers_reel_links";
const REEL_IDS = [
  "article-jpmorgan-python-training",
  "article-quantopian-research-public",
  "article-firmai-financial-ml",
] as const;

const ROW_PATTERN =
  /\(\s*'(article-[a-z0-9-]+)',\s*'((?:[^']|'')+)',\s*'((?:[^']|'')+)',\s*(\d{4}),\s*'(https:\/\/github\.com\/[^']+)',\s*'(github:[^']+)',\s*'([a-z]+)',\s*'([a-z_]+)',\s*'([a-z_]+)',\s*'((?:[^']|'')+)',\s*'((?:[^']|'')+)'\s*\)/gu;

describe(TAG, () => {
  it("inserts the three reel DfDt0GDR8Oa learning links within every schema bound", () => {
    const migration = read(`../migrations/${TAG}.sql`);
    const rows = [...migration.matchAll(ROW_PATTERN)];
    expect(rows).toHaveLength(3);

    const byId = new Map<string, RegExpMatchArray>();
    for (const row of rows) {
      const [
        ,
        id,
        rawTitle,
        rawAuthors,
        rawYear,
        sourceUrl,
        identifier,
        kind,
        stage,
        verdict,
        rawBlockers,
        rawNotes,
      ] = row;
      const title = rawTitle?.replaceAll("''", "'") ?? "";
      const authors = rawAuthors?.replaceAll("''", "'") ?? "";
      const year = Number.parseInt(rawYear ?? "0", 10);
      const blockers = rawBlockers?.replaceAll("''", "'") ?? "";
      const notes = rawNotes?.replaceAll("''", "'") ?? "";

      expect(id).toBeDefined();
      expect(title.trim().length).toBeGreaterThanOrEqual(1);
      expect(title.trim().length).toBeLessThanOrEqual(300);
      expect(authors.length).toBeGreaterThan(0);
      expect(authors.length).toBeLessThanOrEqual(500);
      expect(year).toBeGreaterThanOrEqual(1900);
      expect(year).toBeLessThanOrEqual(2100);
      expect(sourceUrl).toMatch(
        /^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9_-]+$/iu
      );
      expect((sourceUrl ?? "").length).toBeLessThanOrEqual(2000);
      expect(identifier).toBe(
        `github:${sourceUrl?.slice("https://github.com/".length)}`
      );
      expect((identifier ?? "").length).toBeLessThanOrEqual(200);
      expect(RESEARCH_PAPER_KINDS).toContain(kind);
      expect(kind).toBe("article");
      expect(RESEARCH_PAPER_STAGES).toContain(stage);
      expect(stage).toBe("queued");
      expect(RESEARCH_PAPER_VERDICTS).toContain(verdict);
      expect(verdict).toBe("pending");
      expect(blockers.length).toBeGreaterThan(0);
      expect(blockers.length).toBeLessThanOrEqual(4000);
      expect(notes.length).toBeGreaterThan(0);
      expect(notes.length).toBeLessThanOrEqual(4000);
      expect(notes).toContain("DfDt0GDR8Oa");
      expect(notes).toContain(
        "docs/vertex-rebuild/upstream-candidates-20261030.md"
      );

      byId.set(id ?? "", row);
    }

    expect([...byId.keys()]).toEqual([...REEL_IDS]);
    expect(byId.get("article-jpmorgan-python-training")?.[5]).toBe(
      "https://github.com/jpmorganchase/python-training"
    );
    expect(byId.get("article-jpmorgan-python-training")?.[4]).toBe("2026");
    expect(byId.get("article-jpmorgan-python-training")?.[11]).toContain(
      "0c536090"
    );

    expect(byId.get("article-quantopian-research-public")?.[5]).toBe(
      "https://github.com/quantopian/research_public"
    );
    expect(byId.get("article-quantopian-research-public")?.[4]).toBe("2020");
    expect(byId.get("article-quantopian-research-public")?.[11]).toContain(
      "e183ecd0"
    );

    expect(byId.get("article-firmai-financial-ml")?.[5]).toBe(
      "https://github.com/firmai/financial-machine-learning"
    );
    expect(byId.get("article-firmai-financial-ml")?.[4]).toBe("2025");
    expect(byId.get("article-firmai-financial-ml")?.[11]).toContain("a0fda6ac");
  });

  it("is idempotent, skips duplicate source_url or identifier rows, and never overwrites existing rows", () => {
    const migration = read(`../migrations/${TAG}.sql`);
    expect(migration).toContain('INSERT INTO "public"."research_papers"');
    expect(migration).toContain("WHERE NOT EXISTS");
    expect(migration).toContain("rtrim(lower(existing.\"source_url\"), '/')");
    expect(migration).toContain('lower(existing."identifier")');
    expect(migration).toContain("ON CONFLICT DO NOTHING");
    expect(migration).not.toMatch(/^\s*(GRANT|TRUNCATE|UPDATE|DELETE)\s/im);
  });

  it("is journaled under its own number right after the previous entry with a newer timestamp", () => {
    const journal = JSON.parse(read("../migrations/meta/_journal.json")) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const number = Number.parseInt(TAG.slice(0, 4), 10);
    const index = journal.entries.findIndex((entry) => entry.tag === TAG);
    expect(index).toBeGreaterThan(0);
    const current = journal.entries[index];
    const previous = journal.entries[index - 1];
    expect(current).toMatchObject({ idx: number });
    expect(previous).toMatchObject({ idx: number - 1 });
    expect(current?.when ?? 0).toBeGreaterThan(previous?.when ?? 0);
  });

  it("has a matching Drizzle snapshot chained from the previous snapshot", () => {
    const number = Number.parseInt(TAG.slice(0, 4), 10);
    const prevName = String(number - 1).padStart(4, "0");
    const currName = String(number).padStart(4, "0");
    const prevSnap = JSON.parse(
      read(`../migrations/meta/${prevName}_snapshot.json`)
    ) as { id: string };
    const currSnap = JSON.parse(
      read(`../migrations/meta/${currName}_snapshot.json`)
    ) as { id: string; prevId: string };
    expect(currSnap.prevId).toBe(prevSnap.id);
    expect(currSnap.id).not.toBe(prevSnap.id);
  });

  it("rolls back only unedited, unreferenced rows and checks every seeded column and referencing table", () => {
    const rollback = read(`../rollback/${TAG}.down.sql`);
    for (const id of REEL_IDS) {
      expect(rollback).toContain(`'${id}'`);
    }
    for (const col of [
      "title",
      "authors",
      "year",
      "source_url",
      "identifier",
      "kind",
      "blockers",
      "notes",
    ]) {
      expect(rollback).toContain(`p."${col}" IS DISTINCT FROM seed."${col}"`);
    }
    for (const table of [
      "agent_tasks",
      "backtest_results",
      "paper_captures",
      "strategy_specs",
    ]) {
      expect(rollback).toContain(`"public"."${table}"`);
    }
    expect(rollback).toContain(
      'LOCK TABLE "public"."research_papers" IN ACCESS EXCLUSIVE MODE'
    );
    expect(rollback).toContain('p."updated_at" <> p."created_at"');
    expect(rollback).toContain("refusing rollback");
    const rollbackStatements = rollback
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(rollbackStatements).not.toMatch(/CASCADE|TRUNCATE/iu);
  });
});
