import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkStatusLanguage } from "../../../scripts/lib/status-language.ts";
import { STATUS_LANGUAGE_ALLOWLIST } from "./status-language-allowlist.ts";

// Status language guard for the API (owner rule 2026-11-11, card vertex-status-api-guard).
//
// The app shows what the API sends: an error message, a note, a reason, an answer for the
// assistant, and the wire values of the contracts that the app turns into a label. So the rule of
// the app guard (apps/web/src/status-language.test.ts) holds here too: a status is a definite
// state with its reason. A vague placeholder is not a status: "unknown", "N/A", "unavailable",
// "not available", "not known", "not set", "unspecified", a bare dash, "?" or "…".
//
// This test reads every text of packages/api/src (contracts, services and the modules next to
// them) with the scanner in scripts/lib/status-language.ts (what it reads and skips is described
// and tested there). A vague text must have an entry in status-language-allowlist.ts.
// - New text: do not add an entry by reflex. Name the state: the cause, since when, the last known
//   value, the next step.
// - New wire value: name the state too (`not_classified`, `not_reported`, `no_term_data`), not
//   `unknown` or `unavailable`, alone or as a part (`feed_unavailable`). When stored rows keep an
//   old word, map it where the response is built (see `contractValue` in server/flow-snapshot.ts).
// - Entry with `open: true`: a known ambiguous text, or a wire value that the app prints as it
//   arrives. It leaves the list when its replacement merges; the test fails on a stale entry, and
//   MAX_OPEN only goes down.
// - Entry without `open`: checked and kept; the reason says why (a wire value that code compares,
//   an error text that names its cause, a contract rule in prose, a sign or separator).
//
// Regenerate after a deliberate change: run this file with UPDATE_STATUS_LANGUAGE=1, then
// `biome format --write` the list. Existing reasons are kept; a new text, or a higher count of a
// listed text, gets "REASON REQUIRED" and the test fails until the reason is written.

// Open (known ambiguous) entries on 2026-11-25. Lower it with each replacement; never raise it.
const MAX_OPEN = 0;

const ROOT = join(import.meta.dirname);

describe("status language guard: API texts", () => {
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
