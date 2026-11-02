import { oc } from "@orpc/contract";
import { z } from "zod";

// Advisory risk allocator (ported from Gamma Forge engines/risk_allocator.py, which was only a
// skeleton there). It shows the owner's risk caps and computes how much premium or exposure one
// candidate may use under those caps. Advisory only: it does not enforce or change the caps, and
// no procedure here can place, change or cancel an order.

export const RISK_ALLOCATOR_MAX_POSITIONS = 500;
export const RISK_ALLOCATOR_SYMBOL_PATTERN = /^[A-Z]{1,6}(?:[.-][A-Z])?$/u;
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export const OwnerRiskCapsSchema = z.object({
  copyBookNamePct: z.number(),
  copyBookTotalPct: z.number(),
  leapsMinDte: z.number().int(),
  // Effective LEAPS cap of the live gateway. The allocator sizes with this value.
  leapsPremiumPct: z.number(),
  // A decided cap that the live gateway does not accept yet; null once it is live.
  leapsPremiumPending: z
    .object({ commit: z.string(), pct: z.number(), tracking: z.string() })
    .nullable(),
  optionsOnly: z.boolean(),
  optionsOnlyScope: z.string(),
  shortPremiumPct: z.number(),
  source: z.object({
    decided: z.array(z.object({ date: z.string(), rule: z.string() })),
    files: z.array(z.string()),
    repository: z.string(),
  }),
});

const money = z.number().finite().nonnegative().max(1e12);

export const RiskAllocatorPositionSchema = z.object({
  // True for a Crown copy-book leg; only those legs count toward the copy-book caps.
  crownCopy: z.boolean().default(false),
  expiry: z.string().regex(ISO_DATE_PATTERN).nullable().default(null),
  kind: z.enum(["option", "share"]),
  symbol: z.string().regex(RISK_ALLOCATOR_SYMBOL_PATTERN),
  // Options: premium paid. Shares: position value.
  value: money,
});

export const RiskAllocatorCandidateSchema = z.object({
  // True only for a Crown copy-book leg (10%/50% caps, shares allowed). Every other
  // candidate uses the options-only rule set.
  crownCopy: z.boolean().default(false),
  expiry: z.string().regex(ISO_DATE_PATTERN).nullable().default(null),
  kind: z.enum(["option", "share"]),
  symbol: z.string().regex(RISK_ALLOCATOR_SYMBOL_PATTERN),
  // Options: premium per contract (price x multiplier). Shares: price per share.
  unitCost: z.number().finite().positive().max(1e9),
});

export const RISK_ALLOCATOR_MAX_CANDIDATES = 50;

export const RiskAllocatorInputSchema = z.object({
  asOf: z.string().regex(ISO_DATE_PATTERN),
  candidates: z
    .array(RiskAllocatorCandidateSchema)
    .min(1)
    .max(RISK_ALLOCATOR_MAX_CANDIDATES),
  nlv: z.number().finite().positive().max(1e12),
  positions: z
    .array(RiskAllocatorPositionSchema)
    .max(RISK_ALLOCATOR_MAX_POSITIONS)
    .default([]),
});

export const RiskAllocatorLimitSchema = z.object({
  capPct: z.number(),
  capUsd: z.number(),
  id: z.enum(["option-premium", "copy-name", "copy-total"]),
  label: z.string(),
  roomUsd: z.number(),
  usedUsd: z.number(),
});

export const RISK_RULE_SETS = ["options-only", "crown-copy"] as const;

export const RiskAllocatorRowSchema = z.object({
  bindingLimit: RiskAllocatorLimitSchema.shape.id.nullable(),
  blockedReasons: z.array(z.string()),
  candidateDte: z.number().int().nullable(),
  isLeaps: z.boolean(),
  kind: z.enum(["option", "share"]),
  limits: z.array(RiskAllocatorLimitSchema),
  maxUnits: z.number().int().nonnegative(),
  maxUsd: z.number().nonnegative(),
  ruleSet: z.enum(RISK_RULE_SETS),
  symbol: z.string(),
});

export const RiskAllocatorSuggestionSchema = z.object({
  advisoryOnly: z.literal(true),
  rows: z.array(RiskAllocatorRowSchema),
});

export const RISK_ALLOCATOR_ERRORS = {
  FORBIDDEN: { message: "Operator access required", status: 403 },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const riskAllocator = oc.errors(RISK_ALLOCATOR_ERRORS);

const caps = riskAllocator
  .route({
    method: "GET",
    operationId: "riskAllocator.caps",
    path: "/risk-allocator/caps",
    summary:
      "Owner risk caps (read-only snapshot of the market-watch-bot caps)",
    tags: ["Risk allocator"],
  })
  .input(z.object({}))
  .output(OwnerRiskCapsSchema);

const suggest = riskAllocator
  .route({
    method: "POST",
    operationId: "riskAllocator.suggest",
    path: "/risk-allocator/suggest",
    summary:
      "Advisory sizes for candidates under the owner caps (no order is sent)",
    tags: ["Risk allocator"],
  })
  .input(RiskAllocatorInputSchema)
  .output(RiskAllocatorSuggestionSchema);

export const riskAllocatorContract = { caps, suggest };

export type OwnerRiskCaps = z.infer<typeof OwnerRiskCapsSchema>;
export type RiskAllocatorPosition = z.infer<typeof RiskAllocatorPositionSchema>;
export type RiskAllocatorInput = z.input<typeof RiskAllocatorInputSchema>;
export type RiskAllocatorParsedInput = z.infer<typeof RiskAllocatorInputSchema>;
export type RiskAllocatorLimit = z.infer<typeof RiskAllocatorLimitSchema>;
export type RiskAllocatorCandidate = z.infer<
  typeof RiskAllocatorCandidateSchema
>;
export type RiskAllocatorRow = z.infer<typeof RiskAllocatorRowSchema>;
export type RiskRuleSet = (typeof RISK_RULE_SETS)[number];
export type RiskAllocatorSuggestion = z.infer<
  typeof RiskAllocatorSuggestionSchema
>;
