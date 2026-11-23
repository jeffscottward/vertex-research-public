import {
  type ApiClient,
  createApiClient,
  type OpenbbCotOutput,
  type OpenbbEventsOutput,
  type OpenbbIvHistoryHorizon,
  type OpenbbIvHistoryOutput,
  type OpenbbMacroOutput,
  type OpenbbSecOutput,
  type OpenbbShortsOutput,
  type OpenbbStatusOutput,
  type OpenbbVolContextOutput,
} from "@darkfactory/api";

// Browser access to the read-only openbb.* procedures (operator session).

/** A request with no answer after this long shows when it started, with Retry. */
export const OPENBB_REQUEST_TIMEOUT_MS = 30_000;

export interface OpenbbGateway {
  readonly cot: (weeks: number) => Promise<OpenbbCotOutput>;
  readonly events: (from: string, to: string) => Promise<OpenbbEventsOutput>;
  readonly ivHistory: (
    symbol: string,
    sessions?: OpenbbIvHistoryHorizon
  ) => Promise<OpenbbIvHistoryOutput>;
  /** `ids` limits the reply to the named series; without it every series is returned. */
  readonly macro: (
    from: string,
    ids?: readonly string[]
  ) => Promise<OpenbbMacroOutput>;
  readonly sec: (symbol: string) => Promise<OpenbbSecOutput>;
  readonly shorts: (
    symbol: string,
    days: number
  ) => Promise<OpenbbShortsOutput>;
  /** Newest run of each ingest job (the blocked-upstream notices of the Markets page). */
  readonly status: () => Promise<OpenbbStatusOutput>;
  readonly volContext: () => Promise<OpenbbVolContextOutput>;
}

/** Narrow gateway slice for components that only read rolling IV rank/percentile history. */
export type IvHistoryGateway = Pick<OpenbbGateway, "ivHistory">;

export const createBrowserOpenbbGateway = (): OpenbbGateway => {
  let client: ApiClient | undefined;
  const api = () => {
    client ??= createApiClient({ baseUrl: window.location.origin });
    return client.openbb;
  };
  return Object.freeze({
    cot: (weeks: number) => api().cot({ weeks }),
    events: (from: string, to: string) => api().events({ from, to }),
    ivHistory: (symbol: string, sessions?: OpenbbIvHistoryHorizon) =>
      api().ivHistory(
        sessions === undefined ? { symbol } : { sessions, symbol }
      ),
    macro: (from: string, ids?: readonly string[]) =>
      api().macro(ids === undefined ? { from } : { from, ids: [...ids] }),
    sec: (symbol: string) => api().sec({ symbol }),
    shorts: (symbol: string, days: number) => api().shorts({ days, symbol }),
    status: () => api().status({}),
    volContext: () => api().volContext({}),
  });
};
