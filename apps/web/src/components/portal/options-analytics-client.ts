"use client";

import {
  type ApiClient,
  createApiClient,
  type FlowControl,
  type FlowControlInput,
  type OptionsAnalyticsInput,
  type OptionsAnalyticsOutput,
} from "@darkfactory/api";

// Read-only options analytics (optionsAnalytics.snapshot): IV, estimated GEX and flow. The
// optional flowControl (flow.control) feeds the net drift of the wall x drift read.
export interface OptionsAnalyticsGateway {
  readonly flowControl?: (input: FlowControlInput) => Promise<FlowControl>;
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
      snapshot: (input: OptionsAnalyticsInput) =>
        api().optionsAnalytics.snapshot(input),
    });
  };
