import { describe, expect, it } from "vitest";

import { appContract } from "./contract.ts";
import {
  MASTER_RULES_API_ERRORS,
  MASTER_RULES_SEARCH_DEFAULT_LIMIT,
  MASTER_RULES_SEARCH_MAX_LIMIT,
  MasterRulesSearchInputSchema,
  MasterRulesSearchOutputSchema,
  masterRulesContract,
} from "./contracts/master-rules.ts";

describe("masterRules contract", () => {
  it("registers one read procedure, search, on the app contract", () => {
    expect(appContract.masterRules).toBe(masterRulesContract);
    expect(Object.keys(appContract.masterRules)).toEqual(["search"]);
    const { method, operationId, path, tags } =
      masterRulesContract.search["~orpc"].route;
    expect([method, path, operationId, tags]).toEqual([
      "POST",
      "/master-rules/search",
      "masterRules.search",
      ["Master rules"],
    ]);
  });

  it("declares the error codes with their HTTP statuses", () => {
    expect(
      Object.fromEntries(
        Object.entries(MASTER_RULES_API_ERRORS).map(([code, value]) => [
          code,
          value.status,
        ])
      )
    ).toEqual({ BAD_REQUEST: 400, FORBIDDEN: 403, UNAUTHORIZED: 401 });
  });

  it("defaults the limit to 10 and caps it at 25", () => {
    expect(MASTER_RULES_SEARCH_DEFAULT_LIMIT).toBe(10);
    expect(MASTER_RULES_SEARCH_MAX_LIMIT).toBe(25);
    expect(
      MasterRulesSearchInputSchema.parse({
        cls: ["A", "B"],
        kb: "jay-medrow",
        query: " 2s10s ",
      })
    ).toEqual({ cls: ["A", "B"], kb: "jay-medrow", limit: 10, query: "2s10s" });
  });

  it("requires the advisory note and https source URLs in the output", () => {
    const output = {
      cls: null,
      kb: null,
      kbKnown: null,
      matches: [
        {
          cls: "B",
          consensus: 1,
          id: "R1",
          kbTiers: { "kb-one": "top" },
          kbs: ["kb-one"],
          kind: "regime",
          reason: "Fits.",
          rule: "Rule.",
          score: 1,
          sources: [
            {
              kb: "kb-one",
              recordId: "kb-one:regime:1",
              statement: "Statement.",
              url: "https://www.instagram.com/p/AbCdEfGhIjK/",
            },
          ],
          title: "Title",
        },
      ],
      note: "Advisory.",
      query: "curve",
      total: 1,
    };
    expect(MasterRulesSearchOutputSchema.parse(output)).toEqual(output);
    expect(
      MasterRulesSearchOutputSchema.safeParse({ ...output, note: undefined })
        .success
    ).toBe(false);
    const insecure = structuredClone(output);
    const [match] = insecure.matches;
    const [first] = match?.sources ?? [];
    if (first !== undefined) first.url = "http://example.test/post";
    return expect(
      MasterRulesSearchOutputSchema.safeParse(insecure).success
    ).toBe(false);
  });
});
