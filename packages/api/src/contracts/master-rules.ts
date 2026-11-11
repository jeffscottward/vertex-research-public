import { oc } from "@orpc/contract";
import { z } from "zod";

// Trader master rules (research/master-rules): rules that several trader knowledge bases (KBs) agree
// on, classified A-D against the owner's style, each with the KB records it was clustered from.
// Read-only research input. No rule places, sizes or approves an order.

export const MASTER_RULE_CLASSES = ["A", "B", "C", "D"] as const;
export const MASTER_RULES_SEARCH_DEFAULT_LIMIT = 10;
export const MASTER_RULES_SEARCH_MAX_LIMIT = 25;
export const MASTER_RULES_NOTE =
  "Advisory research input from trader knowledge bases. It never authorizes a trade: no rule here places, sizes or approves an order. Cite the knowledge base (kb) names and the source URLs you use; a source with url null has no public link.";

export const MasterRuleClassSchema = z.enum(MASTER_RULE_CLASSES);

const KbIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,63}$/u,
    "Use a knowledge base id such as jay-medrow"
  );

/** Statement text of a paid-source record whose statement is withheld (build-master-rule-pack.mjs PAID_STATEMENT). */
export const PAID_SOURCE_PLACEHOLDER = "Paid source: statement withheld.";

/** One cited KB record: the paraphrased statement and its public post URL, when one is known. */
export const MasterRuleSourceSchema = z
  .object({
    kb: z.string().max(64),
    recordId: z.string().max(128),
    // build-master-rule-pack.mjs caps statements at 300 characters (STATEMENT_MAX).
    statement: z.string().max(300),
    url: z
      .url({ protocol: /^https$/u })
      .max(300)
      .nullable(),
  })
  .strict();

export const MasterRuleSourceTierSchema = z.string().nullable();

/** One searchable rule of the bundled index (build-master-rule-pack.mjs writes it). */
export const MasterRuleIndexRowSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    rule: z.string(),
    kind: z.string(),
    cls: MasterRuleClassSchema,
    reason: z.string(),
    consensus: z.number().int().nullable(),
    kbs: z.array(z.string()),
    sources: z.array(MasterRuleSourceSchema),
  })
  .strict();

export const MasterRulesIndexSchema = z
  .object({
    clusters: z.number().int(),
    debates: z.number().int(),
    kbTiers: z.record(z.string(), MasterRuleSourceTierSchema),
    rows: z.array(MasterRuleIndexRowSchema),
  })
  .strict();

export const MasterRulesSearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    kb: KbIdSchema.optional(),
    cls: z.array(MasterRuleClassSchema).min(1).max(4).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MASTER_RULES_SEARCH_MAX_LIMIT)
      .default(MASTER_RULES_SEARCH_DEFAULT_LIMIT),
  })
  .strict();

export const MasterRuleMatchSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    rule: z.string(),
    kind: z.string(),
    cls: MasterRuleClassSchema,
    reason: z.string(),
    consensus: z.number().int().nullable(),
    kbs: z.array(z.string()),
    // Source tier of each KB in kbs ("top" for the owner's top sources, else null).
    kbTiers: z.record(z.string(), MasterRuleSourceTierSchema),
    sources: z.array(MasterRuleSourceSchema),
    score: z.number(),
  })
  .strict();

export const MasterRulesSearchOutputSchema = z
  .object({
    query: z.string(),
    kb: z.string().nullable(),
    // False when the kb filter names no knowledge base in the index; null without a kb filter.
    kbKnown: z.boolean().nullable(),
    cls: z.array(MasterRuleClassSchema).nullable(),
    total: z.number().int().min(0),
    matches: z.array(MasterRuleMatchSchema),
    note: z.string(),
  })
  .strict();

export type MasterRuleClass = z.infer<typeof MasterRuleClassSchema>;
export type MasterRuleSource = z.infer<typeof MasterRuleSourceSchema>;
export type MasterRuleIndexRow = z.infer<typeof MasterRuleIndexRowSchema>;
export type MasterRulesIndex = z.infer<typeof MasterRulesIndexSchema>;
/** The generated index without sources (master-rules-index.generated.ts). */
export type MasterRulesIndexBase = Omit<MasterRulesIndex, "rows"> & {
  rows: Omit<MasterRuleIndexRow, "sources">[];
};
/** The generated cited sources by rule id (master-rules-sources.generated.ts). */
export type MasterRuleSourcesById = Readonly<
  Record<string, readonly MasterRuleSource[]>
>;
export type MasterRulesSearchInput = z.input<
  typeof MasterRulesSearchInputSchema
>;
export type MasterRulesSearchOutput = z.infer<
  typeof MasterRulesSearchOutputSchema
>;
export type MasterRuleMatch = z.infer<typeof MasterRuleMatchSchema>;

export const MASTER_RULES_API_ERRORS = {
  BAD_REQUEST: { message: "Invalid request", status: 400 },
  FORBIDDEN: { message: "Forbidden", status: 403 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const masterRules = oc.errors(MASTER_RULES_API_ERRORS);

const search = masterRules
  .route({
    method: "POST",
    operationId: "masterRules.search",
    path: "/master-rules/search",
    summary:
      "Search the trader master rules (advisory research input) with their knowledge bases and cited source URLs",
    tags: ["Master rules"],
  })
  .input(MasterRulesSearchInputSchema)
  .output(MasterRulesSearchOutputSchema);

export const masterRulesContract = { search };
