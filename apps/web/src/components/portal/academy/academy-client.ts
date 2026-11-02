// Browser gateway for the Academy oRPC procedures. Injectable for tests.
import {
  type AcademyBacktestInput,
  type AcademyBacktestOutput,
  type AcademyDeployInput,
  type AcademyDeployRequestInput,
  type AcademyDeployRequestOutput,
  type AcademyGateOutput,
  type AcademyTickersOutput,
  type ApiClient,
  createApiClient,
} from "@darkfactory/api";

export interface AcademyGateway {
  readonly tickers: () => Promise<AcademyTickersOutput>;
  readonly backtest: (
    input: AcademyBacktestInput
  ) => Promise<AcademyBacktestOutput>;
  readonly deployPreview: (
    input: AcademyDeployInput
  ) => Promise<AcademyGateOutput>;
  readonly deployRequest: (
    input: AcademyDeployRequestInput
  ) => Promise<AcademyDeployRequestOutput>;
}

export const createBrowserAcademyGateway = (): AcademyGateway => {
  let client: ApiClient | undefined;
  const api = () => {
    client ??= createApiClient({ baseUrl: window.location.origin });
    return client;
  };
  return Object.freeze({
    tickers: () => api().academy.tickers(),
    backtest: (input: AcademyBacktestInput) => api().academy.backtest(input),
    deployPreview: (input: AcademyDeployInput) =>
      api().academy.deployPreview(input),
    deployRequest: (input: AcademyDeployRequestInput) =>
      api().academy.deployRequest(input),
  });
};

/** Human message from an oRPC error. */
export const errorMessage = (error: unknown): string => {
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message;
  return "Request failed";
};
