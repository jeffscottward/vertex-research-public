import { z } from "zod";

import {
  PICK_LIST_SLUG_PATTERN,
  PICK_LIST_THESIS_MAX_LENGTH,
  type PickListImportInput,
  PickListImportInputSchema,
} from "./contracts/pick-lists.ts";

// Pick-list data-source port. A source loads zero or more dated snapshots, each a valid
// PickListImportInput; the caller (scripts/pick-lists/import.ts) sends them to pickLists.import.
// Sources are swappable data: an id is a slug, and no vendor name appears here. Each adapter takes
// its document reader by injection, so it is tested without files. Research only: no order path.

export type PickListSource = Readonly<{
  /** Slug that selects the source (`--adapter <id>`). */
  id: string;
  label: string;
  load: () => Promise<PickListImportInput[]>;
}>;

export type PickListSourceRegistry = Readonly<{
  get: (id: string) => PickListSource | null;
  ids: () => string[];
}>;

/** A source document that cannot be read as pick-list snapshots. */
export class PickListSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PickListSourceError";
  }
}

export const createPickListSourceRegistry = (
  sources: readonly PickListSource[]
): PickListSourceRegistry => {
  const byId = new Map<string, PickListSource>();
  for (const source of sources) {
    if (!PICK_LIST_SLUG_PATTERN.test(source.id))
      throw new PickListSourceError(`Invalid source id: ${source.id}`);
    if (byId.has(source.id))
      throw new PickListSourceError(`Duplicate source id: ${source.id}`);
    byId.set(source.id, source);
  }
  return Object.freeze({
    get: (id: string) => byId.get(id) ?? null,
    ids: () => [...byId.keys()],
  });
};

const describeIssues = (error: z.ZodError): string =>
  error.issues
    .slice(0, 5)
    .map(
      (issue) =>
        `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`
    )
    .join("; ");

const validated = (raw: unknown, where: string): PickListImportInput => {
  const parsed = PickListImportInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new PickListSourceError(
      `${where} is not a valid pick list: ${describeIssues(parsed.error)}`
    );
  return parsed.data;
};

const JsonDocumentSchema = z.object({
  source: z.unknown(),
  sourceLabel: z.unknown(),
  lists: z.array(z.record(z.string(), z.unknown())),
});

const SingleSnapshotSchema = z.record(z.string(), z.unknown());

export type JsonFileSourceOptions = Readonly<{
  id: string;
  label: string;
  /** Returns the JSON text. */
  read: () => Promise<string>;
  /** As-of date for lists that carry none (YYYY-MM-DD). */
  asOf?: string;
}>;

/**
 * Reads a JSON document: either `{ source, sourceLabel, lists: [{ slug, name, asOf?, members }] }`
 * or one snapshot in the pickLists.import shape. Every snapshot is validated; the method is
 * always "manual" (a person prepared the file).
 */
export const jsonFileSource = (
  options: JsonFileSourceOptions
): PickListSource => ({
  id: options.id,
  label: options.label,
  load: async () => {
    let raw: unknown;
    try {
      raw = JSON.parse(await options.read());
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new PickListSourceError("The file is not valid JSON");
      throw error;
    }
    const fallback = options.asOf === undefined ? {} : { asOf: options.asOf };
    const document = JsonDocumentSchema.safeParse(raw);
    if (document.success) {
      const { source, sourceLabel, lists } = document.data;
      return lists.map((entry, index) => {
        const { slug, name, ...rest } = entry;
        return validated(
          {
            ...fallback,
            ...rest,
            source,
            sourceLabel,
            list: { slug, name },
            method: "manual",
          },
          `lists[${index}]`
        );
      });
    }
    const single = SingleSnapshotSchema.safeParse(raw);
    if (!single.success)
      throw new PickListSourceError(
        "The file must hold a JSON object (a lists document or one snapshot)"
      );
    return [
      validated({ ...fallback, ...single.data, method: "manual" }, "The file"),
    ];
  },
});

const WishlistSchema = z.object({
  symbol: z
    .array(
      z.object({
        symbol: z.string(),
        enabled: z.boolean().optional(),
        note: z.string().optional(),
      })
    )
    .default([]),
});

export const WISHLIST_SOURCE = {
  source: "wishlist",
  sourceLabel: "Owner wish list",
  slug: "wishlist",
  name: "Wish list",
} as const;

export type WishlistTomlSourceOptions = Readonly<{
  /** Returns the already parsed TOML document (repeated `[[symbol]]` tables). */
  read: () => Promise<unknown>;
  asOf: string;
}>;

/**
 * The owner's wish list as one snapshot: enabled symbols only (a missing `enabled` counts as
 * enabled), note as the thesis. Budgets are order sizing for another system and are not imported.
 */
export const wishlistTomlSource = (
  options: WishlistTomlSourceOptions
): PickListSource => ({
  id: WISHLIST_SOURCE.source,
  label: WISHLIST_SOURCE.sourceLabel,
  load: async () => {
    const parsed = WishlistSchema.safeParse(await options.read());
    if (!parsed.success)
      throw new PickListSourceError(
        `The wish list is not valid: ${describeIssues(parsed.error)}`
      );
    const members = parsed.data.symbol
      .filter((entry) => entry.enabled !== false)
      .map((entry) => {
        const note = entry.note?.trim().slice(0, PICK_LIST_THESIS_MAX_LENGTH);
        return {
          symbol: entry.symbol,
          ...(note === undefined || note === "" ? {} : { thesis: note }),
        };
      });
    if (members.length === 0)
      throw new PickListSourceError("The wish list has no enabled symbols");
    return [
      validated(
        {
          source: WISHLIST_SOURCE.source,
          sourceLabel: WISHLIST_SOURCE.sourceLabel,
          list: { slug: WISHLIST_SOURCE.slug, name: WISHLIST_SOURCE.name },
          asOf: options.asOf,
          method: "manual",
          members,
        },
        "The wish list"
      ),
    ];
  },
});
