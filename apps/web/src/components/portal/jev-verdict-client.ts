"use client";

import {
  type ApiClient,
  createApiClient,
  type JevVerdictInput,
  type JevVerdictOutput,
} from "@darkfactory/api";

// Display-only JEV verdict (jevVerdict.get reads the cache; jevVerdict.refresh asks JEV
// within the server throttle). Neither call can place, change or cancel orders.
export interface JevVerdictGateway {
  readonly get: (input: JevVerdictInput) => Promise<JevVerdictOutput>;
  readonly refresh: (input: JevVerdictInput) => Promise<JevVerdictOutput>;
}

export const createBrowserJevVerdictGateway = (): JevVerdictGateway => {
  let client: ApiClient | undefined;
  const api = (): ApiClient => {
    client ??= createApiClient({ baseUrl: window.location.origin });
    return client;
  };
  return Object.freeze({
    get: (input: JevVerdictInput) => api().jevVerdict.get(input),
    refresh: (input: JevVerdictInput) => api().jevVerdict.refresh(input),
  });
};
