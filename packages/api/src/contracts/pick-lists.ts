import { oc } from "@orpc/contract";
import { z } from "zod";

import {
  BASKET_MEMBER_SYMBOL_PATTERN,
  BASKET_SYMBOL_PATTERN,
} from "./baskets.ts";
import { CalendarDateSchema } from "./calendar-date.ts";
import { SECTOR_ROTATION_QUADRANTS } from "./sector-rotation.ts";

// Research pick lists (pickLists.*): dated snapshots of external stock-pick lists (a newsletter's
// picks, a strategy's holdings, the owner's wish list), stored with provenance per row
// (source, list, as-of date, import method). A list can become a bucket: a basket ("custom ETF")
// whose members are the list's latest snapshot. A daily screen reports simple trend gates and the
// rotation quadrant per member. Research only: no order path; a pick, a gate or a quadrant never
// authorizes a trade. Source ids are data (slugs); vendor names never appear in domain code.

export const PICK_LIST_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/u;
export const PICK_LIST_NAME_MAX_LENGTH = 80;
export const PICK_LIST_MAX_MEMBERS = 200;
export const PICK_LIST_THESIS_MAX_LENGTH = 2000;
export const PICK_LIST_RATING_MAX_LENGTH = 40;
export const PICK_LIST_SECTOR_MAX_LENGTH = 60;
/** Members one screen call reads bars for (rank order); the rest are reported as not screened. */
export const PICK_LIST_SCREEN_MAX_MEMBERS = 60;
export const PICK_LIST_IMPORT_METHODS = ["manual", "adapter"] as const;
/** Screen gates, in display order. */
export const PICK_LIST_GATES = [
  "emaTrend",
  "aboveVwap20",
  "notOverextended",
] as const;
// The three states without a verdict stay distinct: no_data = no daily bars were read (member.reason
// names the cause), not_evaluated = bars were read but at least one gate gave no verdict (too few bars,
// or no volume in the VWAP window; that gate's detail names the cause), not_screened = the member is
// past the per-run limit and no bars were requested.
export const PICK_LIST_SCREEN_STATUSES = [
  "pass",
  "fail",
  "no_data",
  "not_evaluated",
  "not_screened",
] as const;

export type PickListImportMethod = (typeof PICK_LIST_IMPORT_METHODS)[number];
export type PickListGate = (typeof PICK_LIST_GATES)[number];
export type PickListScreenStatus = (typeof PICK_LIST_SCREEN_STATUSES)[number];

const slug = z.string().regex(PICK_LIST_SLUG_PATTERN);
const name = z.string().trim().min(1).max(PICK_LIST_NAME_MAX_LENGTH);
const optionalText = (max: number) =>
  z.string().trim().min(1).max(max).optional();
const inputSymbol = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .transform((text) => text.toUpperCase())
  .pipe(z.string().regex(BASKET_MEMBER_SYMBOL_PATTERN));
const outputSymbol = z.string().regex(BASKET_MEMBER_SYMBOL_PATTERN);
const positive = z.number().finite().positive();

export const PickListMemberInputSchema = z
  .object({
    /** Date the source added the pick. */
    addedOn: CalendarDateSchema.optional(),
    /** 1 = first; lists without an order omit it. */
    rank: z.number().int().min(1).max(1000).optional(),
    rating: optionalText(PICK_LIST_RATING_MAX_LENGTH),
    sector: optionalText(PICK_LIST_SECTOR_MAX_LENGTH),
    symbol: inputSymbol,
    targetPrice: positive.optional(),
    thesis: optionalText(PICK_LIST_THESIS_MAX_LENGTH),
    /** Source weight as a fraction (0-1); the bucket still uses equal weights. */
    weight: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

export const PickListImportInputSchema = z
  .object({
    asOf: CalendarDateSchema,
    list: z.object({ name, slug }).strict(),
    members: z
      .array(PickListMemberInputSchema)
      .min(1)
      .max(PICK_LIST_MAX_MEMBERS)
      .refine(
        (members) =>
          new Set(members.map((member) => member.symbol)).size ===
          members.length,
        { message: "Each symbol may appear once" }
      ),
    method: z.enum(PICK_LIST_IMPORT_METHODS),
    source: slug,
    sourceLabel: name,
  })
  .strict();

export const PickListMemberSchema = z.object({
  addedOn: z.string().nullable(),
  rank: z.number().int().nullable(),
  rating: z.string().nullable(),
  sector: z.string().nullable(),
  symbol: outputSymbol,
  targetPrice: z.number().finite().nullable(),
  thesis: z.string().nullable(),
  weight: z.number().finite().nullable(),
});

export const PickListSnapshotSchema = z.object({
  asOf: z.string(),
  id: z.string(),
  importedAt: z.string(),
  members: z.array(PickListMemberSchema),
  method: z.enum(PICK_LIST_IMPORT_METHODS),
});

export const PickListSchema = z.object({
  bucketSymbol: z.string().regex(BASKET_SYMBOL_PATTERN).nullable(),
  id: z.string(),
  latest: PickListSnapshotSchema,
  name: z.string(),
  slug,
  snapshotCount: z.number().int().nonnegative(),
  source: slug,
  sourceLabel: z.string(),
});

const GateResultSchema = z.object({
  detail: z.string(),
  ok: z.boolean().nullable(),
});

export const PickListScreenMemberSchema = z.object({
  gates: z.object({
    aboveVwap20: GateResultSchema,
    emaTrend: GateResultSchema,
    notOverextended: GateResultSchema,
  }),
  last: z.number().finite().nullable(),
  lastDate: z.string().nullable(),
  /** Member's own rotation quadrant against SPY (daily). */
  quadrant: z.enum(SECTOR_ROTATION_QUADRANTS).nullable(),
  /** Why `quadrant` is null (no bars, benchmark not loaded, too few bars); null when it is set. */
  quadrantReason: z.string().nullable().optional(),
  reason: z.string().nullable(),
  sector: z.string().nullable(),
  sectorEtf: z.string().nullable(),
  /** Quadrant of the member's sector ETF against SPY (daily). */
  sectorQuadrant: z.enum(SECTOR_ROTATION_QUADRANTS).nullable(),
  /** Why `sectorQuadrant` is null (no sector, no mapped ETF, ETF bars not loaded); null when it is set. */
  sectorQuadrantReason: z.string().nullable().optional(),
  status: z.enum(PICK_LIST_SCREEN_STATUSES),
  symbol: outputSymbol,
});

export const PickListScreenSchema = z.object({
  computedAt: z.string(),
  listId: z.string(),
  members: z.array(PickListScreenMemberSchema),
  snapshotId: z.string(),
});

// Buy proposal (pickLists.proposal): one row per member of every bucketed list, built from the
// screen. Proposal only: the procedure has no order path, and the web page shows no order control.
// The owner rules it applies are options only, defined risk, and max loss per new position at most
// 2% NLV (owner 2026-11-02); the premium cap per name is the risk allocator's caps snapshot.
export const PICK_LIST_PROPOSAL_TIERS = ["full", "half", "none"] as const;
export type PickListProposalTier = (typeof PICK_LIST_PROPOSAL_TIERS)[number];

export const PickListProposalStructureSchema = z.object({
  dte: z.number().int().positive(),
  /** Estimated net debit per share (USD). */
  estDebit: z.number().finite().nonnegative(),
  /** Monthly expiry (third Friday) used for the estimate; the live chain decides at entry. */
  expiry: CalendarDateSchema,
  kind: z.literal("call-debit-spread"),
  /** Black-Scholes call deltas at the rounded strikes. */
  longDelta: z.number().finite(),
  longStrike: positive,
  /** Max loss of one spread (USD): the debit times 100. */
  maxLossPerSpread: z.number().finite().nonnegative(),
  /** Max profit of one spread (USD): strike width times 100 minus the debit. */
  maxProfitPerSpread: z.number().finite(),
  shortDelta: z.number().finite(),
  shortStrike: positive,
});

export const PickListProposalRowSchema = z.object({
  /** Bucket symbols that hold this member. */
  buckets: z.array(z.string().regex(BASKET_SYMBOL_PATTERN)).min(1),
  last: z.number().finite().nullable(),
  lastDate: z.string().nullable(),
  /** Proposed max loss for the whole position as % of NLV; 0 when no entry is proposed. */
  maxLossPctNlv: z.number().finite().nonnegative(),
  notes: z.string(),
  quadrant: z.enum(SECTOR_ROTATION_QUADRANTS).nullable(),
  sectorEtf: z.string().nullable(),
  sectorQuadrant: z.enum(SECTOR_ROTATION_QUADRANTS).nullable(),
  status: z.enum(PICK_LIST_SCREEN_STATUSES),
  structure: PickListProposalStructureSchema.nullable(),
  symbol: outputSymbol,
  tier: z.enum(PICK_LIST_PROPOSAL_TIERS),
  /** Annualized realized volatility (fraction) from one year of daily closes. */
  volatility: z.number().finite().positive().nullable(),
});

export const PickListProposalSchema = z.object({
  buckets: z.array(
    z.object({
      listId: z.string(),
      listName: z.string(),
      memberCount: z.number().int().nonnegative(),
      symbol: z.string().regex(BASKET_SYMBOL_PATTERN),
    })
  ),
  computedAt: z.string(),
  /** Members past the per-call screen limit: no bars were read and no row was built. */
  notProposed: z.array(outputSymbol),
  proposalOnly: z.literal(true),
  rows: z.array(PickListProposalRowSchema),
  rules: z.object({
    dteMax: z.number().int().positive(),
    dteMin: z.number().int().positive(),
    fullMaxLossPct: positive,
    halfMaxLossPct: positive,
    longDelta: positive,
    maxLossGatePct: positive,
    namePremiumCapPct: positive,
    riskFreeRate: z.number().finite(),
    shortDelta: positive,
    targetDte: z.number().int().positive(),
  }),
  /** Sum of maxLossPctNlv over every row. */
  totalMaxLossPct: z.number().finite().nonnegative(),
});

export const PICK_LIST_API_ERRORS = {
  CONFLICT: {
    message: "Another basket already uses this symbol",
    status: 409,
  },
  NOT_FOUND: { message: "Pick list not found", status: 404 },
  STORAGE_ERROR: {
    message:
      "Pick list storage could not be used: it is not configured on this server, or the database call failed. Retry; if it repeats, check the database connection.",
    status: 503,
  },
  VALIDATION_ERROR: { message: "Invalid pick list request", status: 400 },
} as const;

const pickLists = oc.errors(PICK_LIST_API_ERRORS);
const tags = ["Pick lists"];
const IdInputSchema = z.object({ id: z.string().min(1).max(128) }).strict();

const importSnapshot = pickLists
  .route({
    method: "POST",
    operationId: "pickLists.import",
    path: "/pick-lists/import",
    summary:
      "Store one dated pick-list snapshot (replaces the snapshot of the same date)",
    tags,
  })
  .input(PickListImportInputSchema)
  .output(PickListSchema);

const list = pickLists
  .route({
    method: "GET",
    operationId: "pickLists.list",
    path: "/pick-lists",
    summary: "Pick lists with their latest snapshot and provenance",
    tags,
  })
  .input(z.object({}).strict())
  .output(z.object({ items: z.array(PickListSchema) }));

const screen = pickLists
  .route({
    method: "POST",
    operationId: "pickLists.screen",
    path: "/pick-lists/{id}/screen",
    summary:
      "Daily trend gates and rotation quadrants for the latest snapshot's members",
    tags,
  })
  .input(IdInputSchema)
  .output(PickListScreenSchema);

const syncBucket = pickLists
  .route({
    method: "POST",
    operationId: "pickLists.syncBucket",
    path: "/pick-lists/{id}/bucket",
    summary:
      "Create or refresh the list's bucket (equal-weight basket of the latest snapshot)",
    tags,
  })
  .input(
    z
      .object({
        bucketSymbol: z
          .string()
          .trim()
          .transform((text) => text.toUpperCase())
          .pipe(z.string().regex(BASKET_SYMBOL_PATTERN)),
        id: z.string().min(1).max(128),
      })
      .strict()
  )
  .output(
    z.object({
      basketId: z.string(),
      list: PickListSchema,
      memberCount: z.number().int().positive(),
      /** Members left out because a basket holds at most 50 (lowest rank kept). */
      omitted: z.array(outputSymbol),
    })
  );

const proposal = pickLists
  .route({
    method: "GET",
    operationId: "pickLists.proposal",
    path: "/pick-lists/proposal",
    summary:
      "Read-only buy proposal (defined-risk option structures) for every bucketed list; places no order",
    tags,
  })
  .input(z.object({}).strict())
  .output(PickListProposalSchema);

export const pickListsContract = {
  import: importSnapshot,
  list,
  proposal,
  screen,
  syncBucket,
};

export type PickListImportInput = z.input<typeof PickListImportInputSchema>;
export type PickListOutput = z.infer<typeof PickListSchema>;
export type PickListMemberOutput = z.infer<typeof PickListMemberSchema>;
export type PickListScreenOutput = z.infer<typeof PickListScreenSchema>;
export type PickListScreenMemberOutput = z.infer<
  typeof PickListScreenMemberSchema
>;
export type PickListProposalOutput = z.infer<typeof PickListProposalSchema>;
export type PickListProposalRowOutput = z.infer<
  typeof PickListProposalRowSchema
>;
export type PickListProposalStructureOutput = z.infer<
  typeof PickListProposalStructureSchema
>;
export { IdInputSchema as PickListIdInputSchema };
