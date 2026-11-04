import { oc } from "@orpc/contract";
import { z } from "zod";

// Private per-user custom baskets ("fake ETFs"): a tracked price index only.
// No orders, intents, held quantities, alerts or execution linkage.

export const BASKET_SYMBOL_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/;
export const BASKET_MEMBER_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;
export const BASKET_NAME_MAX_LENGTH = 80;
export const BASKET_MAX_MEMBERS = 50;
export const BASKET_BENCHMARK_SYMBOL = "SPY";

const WEIGHT_PATTERN = /^(0|1)(\.[0-9]{1,8})?$/;

const BasketMemberInputSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .toUpperCase()
      .regex(BASKET_MEMBER_SYMBOL_PATTERN, { message: "Invalid ticker" }),
    weight: z.string().trim().regex(WEIGHT_PATTERN, {
      message: "Weight: a decimal from 0 to 1, at most 8 decimals",
    }),
  })
  .strict();

const BasketMembersInputSchema = z
  .array(BasketMemberInputSchema)
  .min(1)
  .max(BASKET_MAX_MEMBERS);

export const BasketMemberSchema = z.object({
  symbol: z.string(),
  weight: z.string(),
  basePrice: z.string().nullable(),
  sharesAtBase: z.string().nullable(),
});

export const BasketSchema = z.object({
  id: z.string().min(1),
  symbol: z.string().regex(BASKET_SYMBOL_PATTERN),
  name: z.string().max(BASKET_NAME_MAX_LENGTH),
  baseDate: z.string().nullable(),
  baseValue: z.string(),
  members: z.array(BasketMemberSchema),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const NullableNumber = z.number().nullable();

export const BasketValuationSchema = z.object({
  basket: BasketSchema,
  baseState: z.enum(["fixed", "provisional", "pending"]),
  baseDate: z.string().nullable(),
  benchmarkSymbol: z.string(),
  points: z.array(
    z.object({
      date: z.string(),
      value: NullableNumber,
      benchmark: NullableNumber,
      stale: z.boolean(),
      missing: z.array(z.string()),
    })
  ),
  latest: z
    .object({
      date: z.string(),
      value: z.number(),
      changePct: z.number(),
      dayChangePct: NullableNumber,
      benchmark: NullableNumber,
    })
    .nullable(),
  staleSymbols: z.array(z.string()),
  members: z.array(
    z.object({
      symbol: z.string(),
      weight: z.number(),
      basePrice: NullableNumber,
      lastPrice: NullableNumber,
      lastDate: z.string().nullable(),
      returnPct: NullableNumber,
      contribution: NullableNumber,
      stale: z.boolean(),
    })
  ),
  // Per-symbol history failures (for example IBKR pacing). Values stay null, never zero.
  unavailable: z.array(z.object({ symbol: z.string(), reason: z.string() })),
  computedAt: z.string(),
});

export const BASKET_API_ERRORS = {
  BAD_REQUEST: { status: 400, message: "Invalid request" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_FOUND: { status: 404, message: "Basket not found" },
  CONFLICT: { status: 409, message: "A basket with this symbol exists" },
  VALIDATION_ERROR: { status: 422, message: "Basket validation failed" },
  STORAGE_ERROR: { status: 503, message: "Basket storage unavailable" },
} as const;

const basketsBase = oc.errors(BASKET_API_ERRORS);
const IdInputSchema = z.object({ id: z.string().min(1).max(128) }).strict();

export const BasketCreateInputSchema = z
  .object({
    symbol: z.string().trim().toUpperCase().regex(BASKET_SYMBOL_PATTERN, {
      message: "Symbol: 1 to 10 letters or digits, starting with a letter",
    }),
    name: z.string().trim().min(1).max(BASKET_NAME_MAX_LENGTH),
    members: BasketMembersInputSchema,
  })
  .strict();

export const BasketUpdateInputSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().trim().min(1).max(BASKET_NAME_MAX_LENGTH).optional(),
    members: BasketMembersInputSchema.optional(),
  })
  .strict()
  .refine((input) => input.name !== undefined || input.members !== undefined, {
    message: "Change the name or the members",
  });

const route = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: `/${string}`,
  operationId: string,
  summary: string
) =>
  basketsBase.route({ method, path, operationId, summary, tags: ["Baskets"] });

const list = route("GET", "/baskets", "baskets.list", "List baskets")
  .input(z.object({}).strict())
  .output(z.object({ items: z.array(BasketSchema) }));

const create = route("POST", "/baskets", "baskets.create", "Create a basket")
  .input(BasketCreateInputSchema)
  .output(BasketSchema);

const update = route(
  "PATCH",
  "/baskets/{id}",
  "baskets.update",
  "Rename a basket or replace its members"
)
  .input(BasketUpdateInputSchema)
  .output(BasketSchema);

const remove = route(
  "DELETE",
  "/baskets/{id}",
  "baskets.remove",
  "Delete a basket"
)
  .input(IdInputSchema)
  .output(z.object({ id: z.string(), removed: z.literal(true) }));

const valuation = route(
  "GET",
  "/baskets/{id}/valuation",
  "baskets.valuation",
  "Basket index history, latest value and member contributions"
)
  .input(IdInputSchema)
  .output(BasketValuationSchema);

export const basketsContract = { list, create, update, remove, valuation };

export type BasketOutput = z.infer<typeof BasketSchema>;
export type BasketValuationOutput = z.infer<typeof BasketValuationSchema>;
export type BasketCreateInput = z.input<typeof BasketCreateInputSchema>;
export type BasketUpdateInput = z.input<typeof BasketUpdateInputSchema>;
