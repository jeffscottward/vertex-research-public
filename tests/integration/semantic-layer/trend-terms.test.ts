import {
  STRATEGY_TREND_INDICATORS,
  StrategyExprSchema,
} from "@darkfactory/api";
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

/** Term id -> strategy DSL indicator name (migration 0075 puts a JSON example in each description). */
const DSL_INDICATORS = [
  ["supertrend", "supertrend"],
  ["alphatrend", "alphaTrend"],
  ["chandelier_exit", "chandelierExit"],
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

  it.each(DSL_INDICATORS)(
    "gives %s a strategy DSL example that the schema accepts as %s",
    (id, name) => {
      const description = terms.find((term) => term.id === id)?.description;
      const example = /\{"type": "indicator"[^}]*\}/u.exec(description ?? "");
      // A DSL field or enum change that makes the stored example invalid fails here.
      const parsed = StrategyExprSchema.parse(
        JSON.parse(example?.[0] ?? "null")
      );
      expect(parsed).toMatchObject({ name, type: "indicator" });
      expect(STRATEGY_TREND_INDICATORS).toContain(name);
      expect(description).toContain(`the indicator "${name}"`);
    }
  );

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
