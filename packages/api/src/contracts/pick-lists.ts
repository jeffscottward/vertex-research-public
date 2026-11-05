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
export const PICK_LIST_SCREEN_STATUSES = ["pass", "fail", "unknown"] as const;

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
    symbol: inputSymbol,
    /** 1 = first; lists without an order omit it. */
    rank: z.number().int().min(1).max(1000).optional(),
    /** Source weight as a fraction (0-1); the bucket still uses equal weights. */
    weight: z.number().finite().min(0).max(1).optional(),
    sector: optionalText(PICK_LIST_SECTOR_MAX_LENGTH),
    rating: optionalText(PICK_LIST_RATING_MAX_LENGTH),
    thesis: optionalText(PICK_LIST_THESIS_MAX_LENGTH),
    targetPrice: positive.optional(),
    /** Date the source added the pick. */
    addedOn: CalendarDateSchema.optional(),
  })
  .strict();

export const PickListImportInputSchema = z
  .object({
    source: slug,
    sourceLabel: name,
    list: z.object({ slug, name }).strict(),
    asOf: CalendarDateSchema,
    method: z.enum(PICK_LIST_IMPORT_METHODS),
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
  })
  .strict();

export const PickListMemberSchema = z.object({
  symbol: outputSymbol,
  rank: z.number().int().nullable(),
  weight: z.number().finite().nullable(),
  sector: z.string().nullable(),
  rating: z.string().nullable(),
  thesis: z.string().nullable(),
  targetPrice: z.number().finite().nullable(),
  addedOn: z.string().nullable(),
});

export const PickListSnapshotSchema = z.object({
  id: z.string(),
  asOf: z.string(),
  method: z.enum(PICK_LIST_IMPORT_METHODS),
  importedAt: z.string(),
  members: z.array(PickListMemberSchema),
});

export const PickListSchema = z.object({
  id: z.string(),
  source: slug,
  sourceLabel: z.string(),
  slug,
  name: z.string(),
  bucketSymbol: z.string().regex(BASKET_SYMBOL_PATTERN).nullable(),
  snapshotCount: z.number().int().nonnegative(),
  latest: PickListSnapshotSchema,
});

const GateResultSchema = z.object({
  ok: z.boolean().nullable(),
  detail: z.string(),
});

export const PickListScreenMemberSchema = z.object({
  symbol: outputSymbol,
  status: z.enum(PICK_LIST_SCREEN_STATUSES),
  last: z.number().finite().nullable(),
  lastDate: z.string().nullable(),
  gates: z.object({
    emaTrend: GateResultSchema,
    aboveVwap20: GateResultSchema,
    notOverextended: GateResultSchema,
  }),
  /** Member's own rotation quadrant against SPY (daily). */
  quadrant: z.enum(SECTOR_ROTATION_QUADRANTS).nullable(),
  sector: z.string().nullable(),
  sectorEtf: z.string().nullable(),
  /** Quadrant of the member's sector ETF against SPY (daily). */
  sectorQuadrant: z.enum(SECTOR_ROTATION_QUADRANTS).nullable(),
  reason: z.string().nullable(),
});

export const PickListScreenSchema = z.object({
  listId: z.string(),
  snapshotId: z.string(),
  computedAt: z.string(),
  members: z.array(PickListScreenMemberSchema),
});

export const PICK_LIST_API_ERRORS = {
  NOT_FOUND: { status: 404, message: "Pick list not found" },
  CONFLICT: {
    status: 409,
    message: "Another basket already uses this symbol",
  },
  VALIDATION_ERROR: { status: 400, message: "Invalid pick list request" },
  STORAGE_ERROR: { status: 503, message: "Pick list storage is unavailable" },
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
        id: z.string().min(1).max(128),
        bucketSymbol: z
          .string()
          .trim()
          .transform((text) => text.toUpperCase())
          .pipe(z.string().regex(BASKET_SYMBOL_PATTERN)),
      })
      .strict()
  )
  .output(
    z.object({
      list: PickListSchema,
      basketId: z.string(),
      memberCount: z.number().int().positive(),
      /** Members left out because a basket holds at most 50 (lowest rank kept). */
      omitted: z.array(outputSymbol),
    })
  );

export const pickListsContract = {
  import: importSnapshot,
  list,
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
export { IdInputSchema as PickListIdInputSchema };
