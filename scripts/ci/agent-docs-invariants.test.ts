import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// AGENTS.md is the one agent index. Claude Code reads CLAUDE.md and
// .claude/skills, so both are symlinks into the harness-agnostic sources.
const root = new URL("../../", import.meta.url);
const at = (path: string): URL => new URL(path, root);

const SKILL_ROLES = [
  "architect",
  "backend",
  "frontend",
  "janitor",
  "pm",
  "qa",
  "release",
  "scalability",
  "security",
];

describe("agent entry points", () => {
  it("links CLAUDE.md to AGENTS.md instead of copying it", async () => {
    expect((await lstat(at("CLAUDE.md"))).isSymbolicLink()).toBe(true);
    return expect(await readlink(at("CLAUDE.md"))).toBe("AGENTS.md");
  });

  it("links .claude/skills to the shared .agents/skills directory", async () => {
    expect((await lstat(at(".claude/skills"))).isSymbolicLink()).toBe(true);
    return expect(await readlink(at(".claude/skills"))).toBe(
      "../.agents/skills"
    );
  });

  // Owner decision 2026-11-10: the owner never reviews code. Merges wait on
  // CI and a fresh-context agent review; trading safety gates stay owner calls.
  it("never makes a person's code review a merge gate", async () => {
    const agents = await readFile(at("AGENTS.md"), "utf8");
    expect(agents).not.toMatch(
      /person's review|a person reviews it|person owns the outcome/u
    );
    // A person or human as the reviewer or approver of code, a diff or a PR.
    expect(agents).not.toMatch(
      /\b(?:person|human)(?:'s)?\s+(?:code\s+)?review\b|\breview(?:ed)?\s+by\s+a\s+(?:person|human)\b|\b(?:person|human)\s+(?:must\s+|should\s+|to\s+)?(?:review|approve)s?\s+(?:the\s+|each\s+|every\s+)?(?:code|diff|PR)\b/iu
    );
    const section = /## Code review practice\n([\s\S]*?)\n## /u.exec(
      agents
    )?.[1];
    expect(section, "Code review practice section").toBeDefined();
    for (const rule of [
      "No merge waits for a person to read code",
      "the owner decided it before the merge",
      "including a code change that changes what one of them allows",
      "does not merge before the owner decides",
      "Arming trading",
      "live orders",
      "Risk settings",
      "kill switches",
    ]) {
      expect(section, rule).toContain(rule);
    }
  });

  return it("gives every role skill matching name and description frontmatter", async () => {
    const roles = (await readdir(at(".agents/skills"))).sort();
    expect(roles).toEqual(SKILL_ROLES);
    for (const role of roles) {
      const skill = await readFile(
        at(`.agents/skills/${role}/SKILL.md`),
        "utf8"
      );
      const frontmatter = /^---\nname: (.+)\ndescription: (.+)\n---\n/u.exec(
        skill
      );
      expect(frontmatter?.[1], role).toBe(role);
      expect(frontmatter?.[2]?.length ?? 0, role).toBeGreaterThan(20);
    }
  });
});
