"use client";

import {
  type ApiClient,
  createApiClient,
  type InstantBacktestSeriesListOutput,
  type SetupReplayPresetsOutput,
  type SetupReplayRunInput,
  type SetupReplayRunOutput,
} from "@darkfactory/api";

import { isOperatorAccessDenied } from "./agent-ops-client.tsx";

// Setup replay (setupReplay.*) plus the stored series list it picks from (instantBacktest.series).
// Read-only research; no write or order procedure exists.
export interface SetupReplayGateway {
  readonly series: () => Promise<InstantBacktestSeriesListOutput>;
  readonly presets: () => Promise<SetupReplayPresetsOutput>;
  readonly run: (input: SetupReplayRunInput) => Promise<SetupReplayRunOutput>;
}

export const createSetupReplayGateway = (
  client: ApiClient
): SetupReplayGateway => ({
  series: () => client.instantBacktest.series(),
  presets: () => client.setupReplay.presets(),
  run: (input) => client.setupReplay.run(input),
});

export const createBrowserSetupReplayGateway = (): SetupReplayGateway => {
  let gateway: SetupReplayGateway | undefined;
  const current = (): SetupReplayGateway => {
    gateway ??= createSetupReplayGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    series: () => current().series(),
    presets: () => current().presets(),
    run: (input: SetupReplayRunInput) => current().run(input),
  });
};

/** One line for the page: the server's message, or the operator-access notice. */
export const describeSetupReplayFailure = (error: unknown): string => {
  if (isOperatorAccessDenied(error)) return "Operator access required.";
  const message =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "message")
      : undefined;
  return typeof message === "string" && message.trim() !== ""
    ? message.trim()
    : "Request failed.";
};
