"use client";

import {
  type ApiClient,
  createApiClient,
  type OptionsChainExpiriesInput,
  type OptionsChainExpiriesOutput,
  type OptionsChainInput,
  type OptionsChainOutput,
} from "@darkfactory/api";

// Read-only options chain (optionsChain.expiries, optionsChain.chain) for /stock/<SYMBOL>.
export interface OptionsChainGateway {
  readonly expiries: (
    input: OptionsChainExpiriesInput
  ) => Promise<OptionsChainExpiriesOutput>;
  readonly chain: (input: OptionsChainInput) => Promise<OptionsChainOutput>;
}

export const createBrowserOptionsChainGateway = (): OptionsChainGateway => {
  let client: ApiClient | undefined;
  const api = (): ApiClient => {
    client ??= createApiClient({ baseUrl: window.location.origin });
    return client;
  };
  return Object.freeze({
    chain: (input: OptionsChainInput) => api().optionsChain.chain(input),
    expiries: (input: OptionsChainExpiriesInput) =>
      api().optionsChain.expiries(input),
  });
};
