"use client";

import {
  type ApiClient,
  createApiClient,
  type OptionsAnalyticsInput,
  type OptionsAnalyticsOutput,
} from "@darkfactory/api";

// Read-only options analytics (optionsAnalytics.snapshot): IV, estimated GEX and flow.
export interface OptionsAnalyticsGateway {
  readonly snapshot: (
    input: OptionsAnalyticsInput
  ) => Promise<OptionsAnalyticsOutput>;
}

export const createBrowserOptionsAnalyticsGateway =
  (): OptionsAnalyticsGateway => {
    let client: ApiClient | undefined;
    return Object.freeze({
      snapshot: (input: OptionsAnalyticsInput) => {
        client ??= createApiClient({ baseUrl: window.location.origin });
        return client.optionsAnalytics.snapshot(input);
      },
    });
  };
