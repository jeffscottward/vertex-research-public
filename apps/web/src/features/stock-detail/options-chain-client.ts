"use client";

import {
  type ApiClient,
  createApiClient,
  type OptionsChainExpiriesInput,
  type OptionsChainExpiriesOutput,
  type OptionsChainInput,
  type OptionsChainOutput,
  type OptionsExpectedMoveInput,
  type OptionsExpectedMoveOutput,
} from "@darkfactory/api";

// Read-only options chain (optionsChain.expiries, optionsChain.chain, optionsChain.expectedMove).
export interface OptionsChainGateway {
  readonly chain: (input: OptionsChainInput) => Promise<OptionsChainOutput>;
  readonly expectedMove: (
    input: OptionsExpectedMoveInput
  ) => Promise<OptionsExpectedMoveOutput>;
  readonly expiries: (
    input: OptionsChainExpiriesInput
  ) => Promise<OptionsChainExpiriesOutput>;
}

export const createBrowserOptionsChainGateway = (): OptionsChainGateway => {
  let client: ApiClient | undefined;
  const api = (): ApiClient => {
    client ??= createApiClient({ baseUrl: window.location.origin });
    return client;
  };
  return Object.freeze({
    chain: (input: OptionsChainInput) => api().optionsChain.chain(input),
    expectedMove: (input: OptionsExpectedMoveInput) =>
      api().optionsChain.expectedMove(input),
    expiries: (input: OptionsChainExpiriesInput) =>
      api().optionsChain.expiries(input),
  });
};
