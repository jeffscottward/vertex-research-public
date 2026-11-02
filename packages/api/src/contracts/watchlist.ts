import { oc } from "@orpc/contract";
import { z } from "zod";

// Private per-user symbol list with optional manual buy-zone bounds.
// No quotes, alerts, orders, intents, quantities or execution linkage.

export const WATCHLIST_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;
export const WATCHLIST_NOTE_MAX_LENGTH = 500;
export const WATCHLIST_MAX_SYMBOLS_PER_ADD = 200;
const WATCHLIST_MAX_TOKEN_LENGTH = 64;
const WATCHLIST_DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/;

export const normalizeWatchlistSymbol = (value: string): string | null => {
  const symbol = value.trim().toUpperCase();
  return WATCHLIST_SYMBOL_PATTERN.test(symbol) ? symbol : null;
};

export type WatchlistSymbolPartition = Readonly<{
  symbols: string[];
  rejected: string[];
}>;

// Normalizes and dedupes (first occurrence wins); invalid tokens are reported, never dropped.
export const partitionWatchlistSymbols = (
  tokens: readonly string[]
): WatchlistSymbolPartition => {
  const symbols: string[] = [];
  const rejected: string[] = [];
  for (const token of tokens) {
    const trimmed = token.trim();
    if (trimmed === "") continue;
    const symbol = normalizeWatchlistSymbol(trimmed);
    if (symbol === null) {
      if (!rejected.includes(trimmed)) rejected.push(trimmed);
    } else if (!symbols.includes(symbol)) {
      symbols.push(symbol);
    }
  }
  return { symbols, rejected };
};

// Paste box splitter: commas, whitespace and newlines (also semicolons).
export const splitWatchlistPaste = (text: string): string[] => {
  return text.split(/[\s,;]+/u).filter((token) => token !== "");
};

// Returns null for anything that is not a plain bounded decimal, so later
// refinements never hand exponent or malformed text to BigInt.
const scaledDecimal = (value: string): bigint | null => {
  if (!WATCHLIST_DECIMAL_PATTERN.test(value)) return null;
  const [whole = "", fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(8, "0"));
};

const buyZoneOrdered = (low: string | null, high: string | null): boolean => {
  const scaledLow = low === null ? null : scaledDecimal(low);
  const scaledHigh = high === null ? null : scaledDecimal(high);
  return scaledLow === null || scaledHigh === null || scaledLow <= scaledHigh;
};

export const WatchlistDecimalSchema = z
  .union([
    z.string().trim().max(24),
    z
      .number()
      .finite()
      .transform((value) => String(value)),
  ])
  .refine((value) => WATCHLIST_DECIMAL_PATTERN.test(value), {
    message: "Expected a positive decimal with at most 8 fractional digits",
  })
  .refine((value) => (scaledDecimal(value) ?? 0n) > 0n, {
    message: "Expected a value greater than zero",
  });

export const WatchlistBuyZoneSchema = z
  .object({
    low: WatchlistDecimalSchema.nullable(),
    high: WatchlistDecimalSchema.nullable(),
  })
  .strict()
  .refine((zone) => buyZoneOrdered(zone.low, zone.high), {
    message: "Buy zone low must not exceed buy zone high",
    path: ["low"],
  });

export const WatchlistItemSchema = z.object({
  id: z.string().min(1),
  symbol: z.string().regex(WATCHLIST_SYMBOL_PATTERN),
  note: z.string().max(WATCHLIST_NOTE_MAX_LENGTH).nullable(),
  buyZoneLow: z.string().nullable(),
  buyZoneHigh: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const WATCHLIST_API_ERRORS = {
  BAD_REQUEST: { status: 400, message: "Invalid request" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_FOUND: { status: 404, message: "Watchlist item not found" },
  CONFLICT: { status: 409, message: "Watchlist item conflict" },
  VALIDATION_ERROR: {
    status: 422,
    message: "Watchlist item validation failed",
  },
  STORAGE_ERROR: { status: 503, message: "Watchlist storage unavailable" },
} as const;

const watchlist = oc.errors(WATCHLIST_API_ERRORS);

export const WatchlistListInputSchema = z.object({}).strict();
export const WatchlistListOutputSchema = z.object({
  items: z.array(WatchlistItemSchema),
});

export const WatchlistAddInputSchema = z
  .object({
    symbols: z
      .array(z.string().max(WATCHLIST_MAX_TOKEN_LENGTH))
      .min(1)
      .max(WATCHLIST_MAX_SYMBOLS_PER_ADD),
  })
  .strict();
export const WatchlistAddOutputSchema = z.object({
  items: z.array(WatchlistItemSchema),
  added: z.array(z.string()),
  existing: z.array(z.string()),
  rejected: z.array(z.string()),
});

export const WatchlistUpdateInputSchema = z
  .object({
    id: z.string().min(1).max(128),
    note: z
      .union([z.string().max(WATCHLIST_NOTE_MAX_LENGTH), z.null()])
      .transform((value) => {
        if (value === null) return null;
        const trimmed = value.trim();
        return trimmed === "" ? null : trimmed;
      })
      .optional(),
    buyZone: WatchlistBuyZoneSchema.optional(),
  })
  .strict()
  .refine((input) => input.note !== undefined || input.buyZone !== undefined, {
    message: "Change the note or the buy zone",
  });

export const WatchlistRemoveInputSchema = z
  .object({
    id: z.string().min(1).max(128),
  })
  .strict();
export const WatchlistRemoveOutputSchema = z.object({
  id: z.string().min(1),
  removed: z.literal(true),
});

const list = watchlist
  .route({
    method: "GET",
    path: "/watchlist",
    operationId: "watchlist.list",
    summary: "List watchlist symbols",
    tags: ["Watchlist"],
  })
  .input(WatchlistListInputSchema)
  .output(WatchlistListOutputSchema);

const add = watchlist
  .route({
    method: "POST",
    path: "/watchlist",
    operationId: "watchlist.add",
    summary: "Add watchlist symbols",
    tags: ["Watchlist"],
  })
  .input(WatchlistAddInputSchema)
  .output(WatchlistAddOutputSchema);

const update = watchlist
  .route({
    method: "PATCH",
    path: "/watchlist/{id}",
    operationId: "watchlist.update",
    summary: "Update a watchlist note or buy zone",
    tags: ["Watchlist"],
  })
  .input(WatchlistUpdateInputSchema)
  .output(WatchlistItemSchema);

const remove = watchlist
  .route({
    method: "DELETE",
    path: "/watchlist/{id}",
    operationId: "watchlist.remove",
    summary: "Remove a watchlist symbol",
    tags: ["Watchlist"],
  })
  .input(WatchlistRemoveInputSchema)
  .output(WatchlistRemoveOutputSchema);

export const watchlistContract = { list, add, update, remove };

export type WatchlistItemOutput = z.infer<typeof WatchlistItemSchema>;
export type WatchlistListOutput = z.infer<typeof WatchlistListOutputSchema>;
export type WatchlistAddInput = z.input<typeof WatchlistAddInputSchema>;
export type WatchlistAddOutput = z.infer<typeof WatchlistAddOutputSchema>;
export type WatchlistUpdateInput = z.input<typeof WatchlistUpdateInputSchema>;
export type WatchlistRemoveInput = z.input<typeof WatchlistRemoveInputSchema>;
export type WatchlistRemoveOutput = z.infer<typeof WatchlistRemoveOutputSchema>;
