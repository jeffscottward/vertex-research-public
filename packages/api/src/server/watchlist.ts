import { AuthAuthorizationError } from "@darkfactory/auth/server";
import {
  DatabaseConflictError,
  DatabasePersistenceError,
  InvalidRepositoryInputError,
  type WatchlistRepository,
} from "@darkfactory/db/server";
import type { WatchlistItem } from "@darkfactory/db/schema";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  partitionWatchlistSymbols,
  type WatchlistItemOutput,
} from "../contracts/watchlist.ts";
import type { ApiContext } from "./context.ts";

// Owner is always the authenticated session user; inputs never carry a user id.

const api = implement(appContract).$context<ApiContext>();

type WatchlistErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "STORAGE_ERROR";

type WatchlistErrorFactories = Readonly<
  Record<WatchlistErrorCode, (options?: { message?: string }) => Error>
>;

const factories = (errors: unknown): WatchlistErrorFactories => {
  return errors as WatchlistErrorFactories;
};

const requireSessionUser = api.middleware(async ({ context, next, errors }) => {
  const failures = factories(errors);
  try {
    const session = await context.requireSession();
    return next({ context: { principal: session.principal } });
  } catch (error) {
    if (!(error instanceof AuthAuthorizationError)) throw error;
    if (error.status === 401) throw failures.UNAUTHORIZED();
    throw failures.FORBIDDEN();
  }
});

const repositoryFor = (
  context: ApiContext,
  errors: unknown
): WatchlistRepository => {
  const repository = context.repositories.watchlist;
  if (repository === undefined) throw factories(errors).STORAGE_ERROR();
  return repository;
};

const mapWatchlistError = (error: unknown, errors: unknown): never => {
  const failures = factories(errors);
  if (error instanceof InvalidRepositoryInputError) {
    throw failures.VALIDATION_ERROR({ message: error.message });
  }
  if (error instanceof DatabaseConflictError) throw failures.CONFLICT();
  if (error instanceof DatabasePersistenceError) throw failures.STORAGE_ERROR();
  throw error;
};

const toWatchlistItemOutput = (item: WatchlistItem): WatchlistItemOutput => ({
  id: item.id,
  symbol: item.symbol,
  note: item.note ?? null,
  buyZoneLow: item.buyZoneLow ?? null,
  buyZoneHigh: item.buyZoneHigh ?? null,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
});

const watchlistList = api.watchlist.list
  .use(requireSessionUser)
  .handler(async ({ context, errors }) => {
    const repository = repositoryFor(context, errors);
    try {
      const items = await repository.listByUser(context.principal.userId);
      return { items: items.map(toWatchlistItemOutput) };
    } catch (error) {
      return mapWatchlistError(error, errors);
    }
  });

const watchlistAdd = api.watchlist.add
  .use(requireSessionUser)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    const { symbols, rejected } = partitionWatchlistSymbols(input.symbols);
    try {
      const result =
        symbols.length === 0
          ? { added: [], existing: [] }
          : await repository.addMany(context.principal.userId, symbols);
      const items = await repository.listByUser(context.principal.userId);
      return {
        items: items.map(toWatchlistItemOutput),
        added: result.added.map((item) => item.symbol),
        existing: [...result.existing],
        rejected,
      };
    } catch (error) {
      return mapWatchlistError(error, errors);
    }
  });

const watchlistUpdate = api.watchlist.update
  .use(requireSessionUser)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    let item: WatchlistItem | null;
    try {
      item = await repository.update({
        id: input.id,
        userId: context.principal.userId,
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.buyZone === undefined ? {} : { buyZone: input.buyZone }),
      });
    } catch (error) {
      return mapWatchlistError(error, errors);
    }
    if (item === null) throw factories(errors).NOT_FOUND();
    return toWatchlistItemOutput(item);
  });

const watchlistRemove = api.watchlist.remove
  .use(requireSessionUser)
  .handler(async ({ context, input, errors }) => {
    const repository = repositoryFor(context, errors);
    let removed: boolean;
    try {
      removed = await repository.remove(input.id, context.principal.userId);
    } catch (error) {
      return mapWatchlistError(error, errors);
    }
    if (!removed) throw factories(errors).NOT_FOUND();
    return { id: input.id, removed: true as const };
  });

export const watchlistRouter = {
  list: watchlistList,
  add: watchlistAdd,
  update: watchlistUpdate,
  remove: watchlistRemove,
};
