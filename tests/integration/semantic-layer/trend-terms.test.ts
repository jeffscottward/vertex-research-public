import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type EvalBackend, startEvalBackend } from "./harness.ts";

// Migration 0074: the five trend indicator terms (source "none", not certified) through the real oRPC
// handler on a database with every migration. The assistant reads them with terms_list and terms_query.
const TREND_TERMS = [
  "alphatrend",
  "chandelier_exit",
  "slingshot",
  "supertrend",
  "ultimate_ma",
] as const;

type ListedTerm = Readonly<{
  id: string;
  source: string;
  certified: boolean;
  description: string;
}>;

let backend: EvalBackend;
let terms: readonly ListedTerm[];

describe("trend indicator terms", () => {
  beforeAll(async () => {
    backend = await startEvalBackend();
    const listed = await backend.callProcedure("semanticTerms/list", {});
    if (!listed.ok) throw new Error(listed.message);
    ({ terms } = listed.value as { terms: readonly ListedTerm[] });
  }, 120_000);

  afterAll(async () => {
    await backend.close();
  });

  it("lists the five terms as uncertified with source none", () => {
    expect(
      terms
        .filter((term) => TREND_TERMS.some((id) => id === term.id))
        .map((term) => [term.id, term.source, term.certified])
        .sort()
    ).toEqual(TREND_TERMS.map((id) => [id, "none", false]));
  });

  it.each(TREND_TERMS)(
    "answers %s with its description and no value",
    async (id) => {
      const description = terms.find((term) => term.id === id)?.description;
      expect(description).toContain("Vertex stores no");
      const result = await backend.callProcedure("semanticTerms/query", {
        term: id,
      });
      if (!result.ok) throw new Error(result.message);
      expect(result.value).toMatchObject({
        answer: `Not available. ${description}`,
        certified: false,
        rowCount: 0,
        rows: [],
        source: "none",
        status: "not_available",
      });
    }
  );
});
