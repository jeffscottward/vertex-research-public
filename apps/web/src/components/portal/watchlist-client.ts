"use client";

import {
  createApiClient,
  type ApiClient,
  type WatchlistAddOutput,
  type WatchlistItemOutput,
} from "@darkfactory/api";

export type WatchlistBuyZoneInput = Readonly<{
  low: string | null;
  high: string | null;
}>;

export type WatchlistEditInput = Readonly<{
  note?: string | null;
  buyZone?: WatchlistBuyZoneInput;
}>;

export interface WatchlistGateway {
  readonly list: () => Promise<WatchlistItemOutput[]>;
  readonly add: (symbols: readonly string[]) => Promise<WatchlistAddOutput>;
  readonly update: (
    id: string,
    input: WatchlistEditInput
  ) => Promise<WatchlistItemOutput>;
  readonly remove: (id: string) => Promise<void>;
}

const createWatchlistGateway = (client: ApiClient): WatchlistGateway => ({
  list: async () => (await client.watchlist.list({})).items,
  add: (symbols) => client.watchlist.add({ symbols: [...symbols] }),
  update: (id, input) => client.watchlist.update({ id, ...input }),
  remove: async (id) => {
    await client.watchlist.remove({ id });
    return;
  },
});

export const createBrowserWatchlistGateway = (): WatchlistGateway => {
  let gateway: WatchlistGateway | undefined;
  const current = (): WatchlistGateway => {
    gateway ??= createWatchlistGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    list: () => current().list(),
    add: (symbols: readonly string[]) => current().add(symbols),
    update: (id: string, input: WatchlistEditInput) =>
      current().update(id, input),
    remove: (id: string) => current().remove(id),
  });
};

const errorCode = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
};

const errorMessage = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) return null;
  const message = Reflect.get(error, "message");
  return typeof message === "string" && message.length > 0 ? message : null;
};

export const describeWatchlistFailure = (error: unknown): string => {
  switch (errorCode(error)) {
    case "UNAUTHORIZED": {
      return "Session expired. Sign in again.";
    }
    case "FORBIDDEN": {
      return "Not permitted for this session.";
    }
    case "NOT_FOUND": {
      return "Row no longer exists. Reload the list.";
    }
    case "VALIDATION_ERROR":
    case "BAD_REQUEST": {
      return `Rejected: ${errorMessage(error) ?? "invalid input"}`;
    }
    case "STORAGE_ERROR": {
      return "Watchlist storage unavailable (503).";
    }
    default: {
      return "Request failed. Retry.";
    }
  }
};

export const upsertWatchlistRow = (
  items: readonly WatchlistItemOutput[],
  next: WatchlistItemOutput
): WatchlistItemOutput[] => {
  return items.map((item) => (item.id === next.id ? next : item));
};
