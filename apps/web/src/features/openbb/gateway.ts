import {
  type ApiClient,
  createApiClient,
  type OpenbbCotOutput,
  type OpenbbEventsOutput,
  type OpenbbMacroOutput,
  type OpenbbSecOutput,
  type OpenbbShortsOutput,
  type OpenbbVolContextOutput,
} from "@darkfactory/api";

// Browser access to the read-only openbb.* procedures (operator session).

export interface OpenbbGateway {
  readonly volContext: () => Promise<OpenbbVolContextOutput>;
  readonly cot: (weeks: number) => Promise<OpenbbCotOutput>;
  readonly macro: (from: string) => Promise<OpenbbMacroOutput>;
  readonly events: (from: string, to: string) => Promise<OpenbbEventsOutput>;
  readonly shorts: (
    symbol: string,
    days: number
  ) => Promise<OpenbbShortsOutput>;
  readonly sec: (symbol: string) => Promise<OpenbbSecOutput>;
}

export const createBrowserOpenbbGateway = (): OpenbbGateway => {
  let client: ApiClient | undefined;
  const api = () => {
    client ??= createApiClient({ baseUrl: window.location.origin });
    return client.openbb;
  };
  return Object.freeze({
    cot: (weeks: number) => api().cot({ weeks }),
    events: (from: string, to: string) => api().events({ from, to }),
    macro: (from: string) => api().macro({ from }),
    sec: (symbol: string) => api().sec({ symbol }),
    shorts: (symbol: string, days: number) => api().shorts({ days, symbol }),
    volContext: () => api().volContext({}),
  });
};
