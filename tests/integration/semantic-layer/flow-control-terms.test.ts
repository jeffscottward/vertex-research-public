import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type EvalBackend, startEvalBackend } from "./harness.ts";

// Migration 0081: the three flow control terms (source "none", not certified) through the real oRPC
// handler on a database with every migration. Each points the assistant to the tool flow_control.
const FLOW_TERMS = [
  "flow_control_state",
  "futures_deep_trades",
  "options_net_drift",
] as const;

type ListedTerm = Readonly<{
  id: string;
  source: string;
  certified: boolean;
  description: string;
}>;

let backend: EvalBackend;
let terms: readonly ListedTerm[];

describe("flow control terms", () => {
  beforeAll(async () => {
    backend = await startEvalBackend();
    const listed = await backend.callProcedure("semanticTerms/list", {});
    if (!listed.ok) throw new Error(listed.message);
    ({ terms } = listed.value as { terms: readonly ListedTerm[] });
  }, 120_000);

  afterAll(async () => {
    await backend.close();
  });

  it("lists the three terms as uncertified with source none", () => {
    expect(
      terms
        .filter((term) => FLOW_TERMS.some((id) => id === term.id))
        .map((term) => [term.id, term.source, term.certified])
        .sort()
    ).toEqual(FLOW_TERMS.map((id) => [id, "none", false]));
  });

  it.each(FLOW_TERMS)(
    "terms_query answers not_available for %s and returns the description that names flow_control",
    async (id) => {
      const description = terms.find((term) => term.id === id)?.description;
      expect(description).toContain("Call the tool flow_control");
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

  it("drift_level still answers from Postgres", async () => {
    const result = await backend.callProcedure("semanticTerms/query", {
      term: "drift_level",
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.value).toMatchObject({ certified: true, status: "ok" });
    expect(result.value).not.toMatchObject({ source: "none" });
  });
});
