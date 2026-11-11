import { readFileSync } from "node:fs";

import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type { Repositories } from "@darkfactory/db/server";
import { call } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

import {
  MASTER_RULES_NOTE,
  MASTER_RULES_SEARCH_MAX_LIMIT,
  type MasterRuleIndexRow,
  type MasterRulesIndex,
  MasterRulesIndexSchema,
  MasterRulesSearchInputSchema,
  MasterRulesSearchOutputSchema,
} from "./contracts/master-rules.ts";
import { createApiContext } from "./server/context.ts";
import {
  MASTER_RULES_INDEX,
  masterRulesRouter,
  searchMasterRules,
  searchWords,
} from "./server/master-rules.ts";
import { MASTER_RULE_SOURCES } from "./server/master-rules-sources.generated.ts";

// Fictional rules, KBs and URLs except in the "bundled index" block, which reads the committed data.
const row = (
  over: Partial<MasterRuleIndexRow> & Pick<MasterRuleIndexRow, "id">
): MasterRuleIndexRow => ({
  cls: "B",
  consensus: 1,
  kbs: ["kb-one"],
  kind: "regime",
  reason: "Fits our style.",
  rule: `Rule ${over.id}.`,
  sources: [],
  title: `Title ${over.id}`,
  ...over,
});

const source = (kb: string, recordId: string, statement: string) => ({
  kb,
  recordId,
  statement,
  url: `https://www.instagram.com/p/${recordId.replaceAll(":", "")}/`,
});

const INDEX: MasterRulesIndex = {
  clusters: 5,
  debates: 0,
  kbTiers: { "kb-one": null, "kb-top": "top", "kb-two": null },
  rows: [
    row({
      id: "R1",
      kbs: ["kb-one", "kb-top"],
      rule: "Watch the curve before small caps.",
      sources: [
        source("kb-one", "kb-one:regime:1", "The curve leads."),
        source("kb-top", "kb-top:regime:4", "A steep curve helps."),
      ],
      title: "Curve leads small caps",
    }),
    row({
      cls: "A",
      consensus: 4,
      id: "R2",
      kbs: ["kb-two"],
      rule: "Use a yield curve inversion as a warning.",
      title: "Yield curve warning",
    }),
    row({
      cls: "D",
      id: "R3",
      kbs: ["kb-top"],
      rule: "Sell 2s10s steepeners into the auction.",
      sources: [
        source("kb-top", "kb-top:regime:9", "2s10s steepener into auctions."),
      ],
      title: "Auction steepener",
    }),
    row({ id: "R4", kbs: ["kb-one"], title: "Stops at invalidation" }),
    row({ id: "R5", kbs: ["kb-two"], title: "Size from the stop" }),
  ],
};

const search = (input: unknown) =>
  searchMasterRules(INDEX, MasterRulesSearchInputSchema.parse(input));

describe("searchWords", () => {
  it("lower-cases, splits on punctuation and drops a plain plural s", () => {
    expect(searchWords("Yields, 2s10s & the 10y-2y CURVES; stress")).toEqual([
      "yield",
      "2s10s",
      "the",
      "10y",
      "2y",
      "curve",
      "stress",
    ]);
  });
});

describe("searchMasterRules", () => {
  it("ranks by score, then class and consensus, and adds the advisory note", () => {
    const result = search({ query: "yield curve" });
    expect(result.note).toBe(MASTER_RULES_NOTE);
    expect(result.note).toMatch(/never authorizes a trade/u);
    expect(result.matches.map((match) => match.id)).toEqual(["R2", "R1"]);
    expect(result.total).toBe(2);
    expect(result.kb).toBeNull();
    expect(result.kbKnown).toBeNull();
    expect(result.cls).toBeNull();
    expect(result.matches[0]?.score).toBeGreaterThan(
      result.matches[1]?.score ?? 0
    );
    return expect(MasterRulesSearchOutputSchema.parse(result)).toEqual(result);
  });

  it("filters by knowledge base, reports tiers and puts that KB's sources first", () => {
    const result = search({ kb: "kb-top", query: "curve 2s10s" });
    expect(result.kbKnown).toBe(true);
    expect(result.matches.map((match) => match.id)).toEqual(["R1", "R3"]);
    const curve = result.matches.find((match) => match.id === "R1");
    expect(curve?.kbTiers).toEqual({ "kb-one": null, "kb-top": "top" });
    expect(curve?.sources.map((entry) => entry.kb)).toEqual([
      "kb-top",
      "kb-one",
    ]);
    const unknown = search({ kb: "kb-missing", query: "curve" });
    expect(unknown.kbKnown).toBe(false);
    return expect(unknown.matches).toEqual([]);
  });

  it("filters by class and applies the limit after ranking", () => {
    expect(
      search({ cls: ["A", "D"], query: "curve 2s10s" }).matches.map(
        (match) => match.id
      )
    ).toEqual(["R2", "R3"]);
    const limited = search({ limit: 1, query: "curve" });
    expect(limited.total).toBe(2);
    return expect(limited.matches.map((match) => match.id)).toEqual(["R1"]);
  });

  it("matches words in KB names and cited statements, and lists rows for stop-word queries", () => {
    expect(search({ query: "two" }).matches.map((match) => match.id)).toEqual([
      "R2",
      "R5",
    ]);
    expect(search({ query: "steep" }).matches.map((match) => match.id)).toEqual(
      ["R1"]
    );
    expect(search({ query: "zebra" }).matches).toEqual([]);
    // No searchable word at all (punctuation only) matches nothing instead of listing every row.
    expect(search({ query: "???" })).toMatchObject({ matches: [], total: 0 });
    return expect(
      search({ kb: "kb-one", query: "what is the rule" }).matches.map(
        (match) => match.id
      )
    ).toEqual(["R1", "R4"]);
  });

  it("bounds the input: a query, a KB id, classes A-D and a limit of 1-25 (default 10)", () => {
    expect(MasterRulesSearchInputSchema.parse({ query: "x" }).limit).toBe(10);
    for (const bad of [
      {},
      { query: " " },
      { limit: MASTER_RULES_SEARCH_MAX_LIMIT + 1, query: "x" },
      { cls: ["E"], query: "x" },
      { kb: "Jay Medrow", query: "x" },
      { extra: true, query: "x" },
    ])
      expect(
        MasterRulesSearchInputSchema.safeParse(bad).success,
        JSON.stringify(bad)
      ).toBe(false);
  });
});

describe("bundled master-rules index", () => {
  it("is current with research/master-rules classification and rule pack (rebuild all with build-master-rule-pack.mjs)", () => {
    const committed = (name: string): unknown =>
      JSON.parse(
        readFileSync(
          new URL(`../../../research/master-rules/${name}`, import.meta.url),
          "utf8"
        )
      );
    const classification = committed("classification.json") as Omit<
      MasterRulesIndex,
      "rows"
    > & { rows: Omit<MasterRuleIndexRow, "sources">[] };
    const pack = committed("rule-pack.json") as {
      rules: Pick<MasterRuleIndexRow, "id" | "sources">[];
    };
    expect(MasterRulesIndexSchema.parse(MASTER_RULES_INDEX)).toEqual(
      MASTER_RULES_INDEX
    );
    expect(MASTER_RULES_INDEX.kbTiers).toEqual(classification.kbTiers);
    expect([MASTER_RULES_INDEX.clusters, MASTER_RULES_INDEX.debates]).toEqual([
      classification.clusters,
      classification.debates,
    ]);
    expect(
      MASTER_RULES_INDEX.rows.map(({ sources: _sources, ...row }) => row)
    ).toEqual(
      classification.rows.map(
        ({ cls, consensus, id, kbs, kind, reason, rule, title }) => ({
          cls,
          consensus,
          id,
          kbs,
          kind,
          reason,
          rule,
          title,
        })
      )
    );
    const rows = new Map(
      MASTER_RULES_INDEX.rows.map((entry) => [entry.id, entry])
    );
    for (const rule of pack.rules)
      expect(rows.get(rule.id)?.sources, rule.id).toEqual(rule.sources);
    for (const id of Object.keys(MASTER_RULE_SOURCES))
      expect(rows.has(id), id).toBe(true);
  });

  it("marks jay-medrow and nicholas-crown as top sources and cites only public post URLs", () => {
    expect(MASTER_RULES_INDEX.kbTiers["jay-medrow"]).toBe("top");
    expect(MASTER_RULES_INDEX.kbTiers["nicholas-crown"]).toBe("top");
    const sources = MASTER_RULES_INDEX.rows.flatMap((entry) => entry.sources);
    expect(sources.length).toBeGreaterThan(1000);
    for (const entry of sources) {
      expect(Object.keys(entry).sort()).toEqual([
        "kb",
        "recordId",
        "statement",
        "url",
      ]);
      expect(entry.statement).not.toMatch(/\/home\/|\/Users\/|\.md\b/u);
      if (entry.url !== null)
        expect(entry.url).toMatch(
          /^https:\/\/(?:www\.(?:instagram|youtube|tiktok)\.com|x\.com|letter\.nicholascrown\.com)\//u
        );
    }
    for (const entry of MASTER_RULES_INDEX.rows)
      expect(entry.sources.length).toBeLessThanOrEqual(8);
  });

  it("finds Jay Medrow's 2s10s yield-curve rule with its Instagram sources", () => {
    const result = searchMasterRules(
      MASTER_RULES_INDEX,
      MasterRulesSearchInputSchema.parse({
        kb: "jay-medrow",
        query: "2s10s yield curve",
      })
    );
    const [first] = result.matches;
    expect(first?.title).toMatch(/2s10s/u);
    expect(first?.kbs).toContain("jay-medrow");
    expect(first?.kbTiers["jay-medrow"]).toBe("top");
    expect(first?.sources[0]?.kb).toBe("jay-medrow");
    expect(first?.sources[0]?.url).toMatch(
      /^https:\/\/www\.instagram\.com\/p\/[A-Za-z0-9_-]+\/$/u
    );
    expect(result.matches.length).toBeLessThanOrEqual(10);
    for (const match of result.matches)
      expect(match.kbs).toContain("jay-medrow");
  });
});

// Router: the operator gate applies; a read-access agent key may search.
const OPERATOR = "operator@domain.test";
const at = new Date("2026-11-11T12:00:00.000Z");

const session = (email: string): SafeAuthSession => ({
  principal: { role: "member", status: "active", userId: `user-${email}` },
  session: {
    createdAt: at,
    expiresAt: new Date("2026-11-12T12:00:00.000Z"),
    id: `session-${email}`,
    ipAddress: null,
    updatedAt: at,
    userAgent: null,
    userId: `user-${email}`,
  },
  user: {
    createdAt: at,
    email,
    emailVerified: true,
    id: `user-${email}`,
    image: null,
    name: email,
    role: "member",
    status: "active",
    updatedAt: at,
  },
});

const contextFor = (caller: "operator" | "stranger" | "anonymous" | "key") => {
  const headers = new Headers();
  if (caller === "key") headers.set("x-api-key", "fictional-agent-key");
  return createApiContext(
    new Request("https://darkfactory.localhost/api/orpc", { headers }),
    {
      agentApiKeys: {
        authenticate: vi.fn(async () => ({
          access: "read" as const,
          apiKeyId: "key-1",
          email: OPERATOR,
          emailVerified: true,
          role: "member" as const,
          status: "active" as const,
          userId: "user-key",
        })),
      } as unknown as NonNullable<
        Parameters<typeof createApiContext>[1]["agentApiKeys"]
      >,
      capabilities: {
        ai: false,
        analytics: false,
        emailDelivery: false,
        telemetryExport: false,
      },
      operatorEmails: [OPERATOR],
      repositories: {} as unknown as Repositories,
      requestId: "request-1",
      requireRole: async () => {
        throw new AuthAuthorizationError(
          AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
          401
        );
      },
      requireSession: async () => {
        if (caller === "anonymous" || caller === "key")
          throw new AuthAuthorizationError(
            AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
            401
          );
        return session(
          caller === "operator" ? OPERATOR : "someone@domain.test"
        );
      },
    }
  );
};

describe("masterRules.search procedure", () => {
  it("answers an operator session and a read-access agent key from the bundled index", async () => {
    for (const caller of ["operator", "key"] as const) {
      const result = await call(
        masterRulesRouter.search,
        { kb: "jay-medrow", limit: 3, query: "2s10s yield curve" },
        { context: contextFor(caller), path: ["masterRules", "search"] }
      );
      expect(result.matches).toHaveLength(3);
      expect(result.note).toBe(MASTER_RULES_NOTE);
    }
  });

  it("refuses a signed-in non-operator and an anonymous caller", async () => {
    await expect(
      call(
        masterRulesRouter.search,
        { query: "curve" },
        { context: contextFor("stranger"), path: ["masterRules", "search"] }
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    return expect(
      call(
        masterRulesRouter.search,
        { query: "curve" },
        { context: contextFor("anonymous"), path: ["masterRules", "search"] }
      )
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
