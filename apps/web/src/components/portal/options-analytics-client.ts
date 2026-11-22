"use client";

import {
  type ApiClient,
  createApiClient,
  type GreekHeatmapInput,
  type GreekHeatmapOutput,
  type OptionsAnalyticsInput,
  type OptionsAnalyticsOutput,
} from "@darkfactory/api";

// Read-only options analytics (optionsAnalytics.snapshot & optionsAnalytics.greekHeatmap):
// IV, estimated GEX, strike-by-expiry Greek exposure heatmap and option flow.
export interface OptionsAnalyticsGateway {
  readonly snapshot: (
    input: OptionsAnalyticsInput
  ) => Promise<OptionsAnalyticsOutput>;
  readonly greekHeatmap: (
    input: GreekHeatmapInput
  ) => Promise<GreekHeatmapOutput>;
}

export const createBrowserOptionsAnalyticsGateway =
  (): OptionsAnalyticsGateway => {
    let client: ApiClient | undefined;
    const api = (): ApiClient => {
      client ??= createApiClient({ baseUrl: window.location.origin });
      return client;
    };
    return Object.freeze({
      greekHeatmap: (input: GreekHeatmapInput) =>
        api().optionsAnalytics.greekHeatmap(input),
      snapshot: (input: OptionsAnalyticsInput) =>
        api().optionsAnalytics.snapshot(input),
    });
  };
