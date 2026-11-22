import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkStatusLanguage } from "../../../scripts/lib/status-language.ts";
import { STATUS_LANGUAGE_ALLOWLIST } from "./status-language-allowlist.ts";

// Status language guard (owner rule 2026-11-11, card vertex-no-unknown-status).
//
// Every status the app shows is a definite state with its reason, since when, and what happens
// next. A vague placeholder is not a status: "unknown", "N/A", "unavailable", "not available",
// "not known", "not set", "unspecified", a bare dash, "?" or "…".
//
// This test reads every displayed text of apps/web/src with the scanner in
// scripts/lib/status-language.ts (what it reads and skips is described and tested there). The
// texts of the API contracts and services have their own guard:
// packages/api/src/status-language.test.ts.
// A vague text must have an entry in status-language-allowlist.ts.
// - New text: do not add an entry by reflex. Name the state: the cause, since when, the last known
//   value, the next step ("Gateway disconnected since 01:13 ET · retrying"). Real uncertainty
//   stays visible, but it is named ("Order outcome not confirmed by IBKR since 14:02 · checking").
// - Entry with `open: true`: a known ambiguous text from the audit. It leaves the list when its
//   replacement merges; the test fails on a stale entry, and MAX_OPEN only goes down.
// - Entry without `open`: checked and kept; the reason says why (an explanation in prose, an error
//   text that names its cause, a mark between two real values).
//
// Regenerate after a deliberate change: run this file with UPDATE_STATUS_LANGUAGE=1, then
// `biome format --write` the list. Existing reasons are kept; a new text, or a higher count of a
// listed text, gets "REASON REQUIRED" and the test fails until the reason is written.

// Open (known ambiguous) entries on 2026-11-13. Lower it with each replacement; never raise it.
const MAX_OPEN = 15;

const ROOT = join(import.meta.dirname);

describe("status language guard", () => {
  const { added, stale, withoutReason, open } = checkStatusLanguage(
    ROOT,
    "status-language-allowlist.ts",
    STATUS_LANGUAGE_ALLOWLIST,
    process.env["UPDATE_STATUS_LANGUAGE"] === "1"
  );

  it("has a reason for every allowed text", () => {
    expect(withoutReason).toEqual([]);
  });

  it("allows no new vague status text without an entry and a reason", () => {
    // A failure here means: name the state (cause, since when, next step) instead of the vague
    // word, or add an entry with its reason to status-language-allowlist.ts.
    expect(added).toEqual([]);
  });

  it("has no stale entry: a replaced text leaves the list", () => {
    expect(stale).toEqual([]);
  });

  it("lets the number of known ambiguous texts only go down", () => {
    // Fewer open entries: lower MAX_OPEN to the new number in the same change.
    expect(open).toBe(MAX_OPEN);
  });
});
