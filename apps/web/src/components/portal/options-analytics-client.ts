"use client";

import {
  type ApiClient,
  createApiClient,
  type FlowControl,
  type FlowControlInput,
  type GreekHeatmapInput,
  type GreekHeatmapOutput,
  type OptionsAnalyticsInput,
  type OptionsAnalyticsOutput,
} from "@darkfactory/api";

// Read-only options analytics (optionsAnalytics.snapshot & optionsAnalytics.greekHeatmap):
// IV, estimated GEX, strike-by-expiry Greek exposure heatmap and option flow. The optional
// flowControl (flow.control) feeds the net drift of the wall x drift read.
export interface OptionsAnalyticsGateway {
  readonly flowControl?: (input: FlowControlInput) => Promise<FlowControl>;
  readonly greekHeatmap: (
    input: GreekHeatmapInput
  ) => Promise<GreekHeatmapOutput>;
  readonly snapshot: (
    input: OptionsAnalyticsInput
  ) => Promise<OptionsAnalyticsOutput>;
}

export const createBrowserOptionsAnalyticsGateway =
  (): OptionsAnalyticsGateway => {
    let client: ApiClient | undefined;
    const api = (): ApiClient => {
      client ??= createApiClient({ baseUrl: window.location.origin });
      return client;
    };
    return Object.freeze({
      flowControl: (input: FlowControlInput) => api().flow.control(input),
      greekHeatmap: (input: GreekHeatmapInput) =>
        api().optionsAnalytics.greekHeatmap(input),
      snapshot: (input: OptionsAnalyticsInput) =>
        api().optionsAnalytics.snapshot(input),
    });
  };
