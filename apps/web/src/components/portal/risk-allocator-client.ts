"use client";

import {
  type ApiClient,
  createApiClient,
  type OwnerRiskCaps,
  type RiskAllocatorInput,
  type RiskAllocatorSuggestion,
} from "@darkfactory/api";

// Advisory risk allocator (riskAllocator.*). Both procedures only compute; no write procedure exists.
export interface RiskAllocatorGateway {
  readonly caps: () => Promise<OwnerRiskCaps>;
  readonly suggest: (
    input: RiskAllocatorInput
  ) => Promise<RiskAllocatorSuggestion>;
}

export const createRiskAllocatorGateway = (
  client: ApiClient
): RiskAllocatorGateway => ({
  caps: () => client.riskAllocator.caps({}),
  suggest: (input) => client.riskAllocator.suggest(input),
});

export const createBrowserRiskAllocatorGateway = (): RiskAllocatorGateway => {
  let gateway: RiskAllocatorGateway | undefined;
  const current = (): RiskAllocatorGateway => {
    gateway ??= createRiskAllocatorGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    caps: () => current().caps(),
    suggest: (input: RiskAllocatorInput) => current().suggest(input),
  });
};
