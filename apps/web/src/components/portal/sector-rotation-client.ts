"use client";

import {
  type ApiClient,
  createApiClient,
  SECTOR_ROTATION_MAX_CUSTOM_SYMBOLS,
  SECTOR_ROTATION_SECTORS,
  type SectorRotationMapInput,
  type SectorRotationMapOutput,
  WATCHLIST_SYMBOL_PATTERN,
} from "@darkfactory/api";
import { isOperatorAccessDenied } from "./agent-ops-client.tsx";
import { SECTORS_PRESET_ID } from "./sector-rotation-params.ts";

// Sector rotation map (sectorRotation.map) and the symbol lists a map can use. Read only:
// nothing here creates, routes or simulates an order.

export type SectorRotationUniverseChoice =
  | Readonly<{ kind: "sectors" }>
  | Readonly<{ kind: "custom"; symbols: readonly string[] }>;

/** One entry of the universe picker. */
export type SectorRotationUniversePreset = Readonly<{
  id: string;
  label: string;
  universe: SectorRotationUniverseChoice;
}>;

export interface SectorRotationGateway {
  readonly map: (
    input: SectorRotationMapInput
  ) => Promise<SectorRotationMapOutput>;
  readonly universes: () => Promise<readonly SectorRotationUniversePreset[]>;
}

export const SECTORS_PRESET: SectorRotationUniversePreset = Object.freeze({
  id: SECTORS_PRESET_ID,
  label: `Sector ETFs (${SECTOR_ROTATION_SECTORS.length})`,
  universe: Object.freeze({ kind: "sectors" }),
});

/** Valid, unique, upper-case symbols, at most the custom map limit. */
export const usableSymbols = (symbols: readonly string[]): string[] =>
  [
    ...new Set(
      symbols
        .map((symbol) => symbol.trim().toUpperCase())
        .filter((symbol) => WATCHLIST_SYMBOL_PATTERN.test(symbol))
    ),
  ].slice(0, SECTOR_ROTATION_MAX_CUSTOM_SYMBOLS);

const customPreset = (
  id: string,
  name: string,
  symbols: readonly string[]
): SectorRotationUniversePreset[] => {
  const usable = usableSymbols(symbols);
  return usable.length === 0
    ? []
    : [
        {
          id,
          label: `${name} (${usable.length})`,
          universe: { kind: "custom", symbols: usable },
        },
      ];
};

export type TickerListResult =
  | Readonly<{ ok: true; symbols: readonly string[] }>
  | Readonly<{ ok: false; message: string }>;

/** Reads a typed list: tickers separated by commas or spaces. */
export const parseTickerList = (text: string): TickerListResult => {
  const parts = text
    .split(/[\s,;]+/u)
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part !== "");
  if (parts.length === 0)
    return { message: "Type at least one ticker.", ok: false };
  const invalid = parts.filter((part) => !WATCHLIST_SYMBOL_PATTERN.test(part));
  if (invalid.length > 0)
    return { message: `Not a ticker: ${invalid.join(", ")}.`, ok: false };
  const symbols = [...new Set(parts)];
  if (symbols.length > SECTOR_ROTATION_MAX_CUSTOM_SYMBOLS)
    return {
      message: `Use at most ${SECTOR_ROTATION_MAX_CUSTOM_SYMBOLS} tickers (you typed ${symbols.length}).`,
      ok: false,
    };
  return { ok: true, symbols };
};

export const createSectorRotationGateway = (
  client: ApiClient
): SectorRotationGateway => ({
  map: (input) => client.sectorRotation.map(input),
  universes: async () => {
    // A list that fails to load is left out; the sector ETFs are always there.
    const [watchlist, baskets] = await Promise.allSettled([
      client.watchlist.list({}),
      client.baskets.list({}),
    ]);
    return [
      SECTORS_PRESET,
      ...(watchlist.status === "fulfilled"
        ? customPreset(
            "watchlist",
            "Watchlist",
            watchlist.value.items.map((item) => item.symbol)
          )
        : []),
      ...(baskets.status === "fulfilled"
        ? baskets.value.items.flatMap((basket) =>
            customPreset(
              `basket:${basket.id}`,
              `Basket ${basket.name}`,
              basket.members.map((member) => member.symbol)
            )
          )
        : []),
    ];
  },
});

export const createBrowserSectorRotationGateway = (): SectorRotationGateway => {
  let gateway: SectorRotationGateway | undefined;
  const current = (): SectorRotationGateway => {
    gateway ??= createSectorRotationGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    map: (input: SectorRotationMapInput) => current().map(input),
    universes: () => current().universes(),
  });
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

export const SECTOR_ROTATION_NOT_COLLECTED_TEXT =
  "Sector rotation not yet collected. The nightly job fills it after the US close.";

/** One line for the page: the operator notice, the not-collected notice or the server's message. */
export const describeSectorRotationFailure = (error: unknown): string => {
  if (isOperatorAccessDenied(error)) return "Operator access required.";
  if (field(error, "code") === "NOT_FOUND")
    return SECTOR_ROTATION_NOT_COLLECTED_TEXT;
  const message = field(error, "message");
  return typeof message === "string" && message.trim() !== ""
    ? message.trim()
    : "Request failed.";
};
