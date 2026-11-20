"use client";

import {
  type ApiClient,
  createApiClient,
  type DeepValueOutput,
  type DeepValueScoreOutput,
  type RotationMatrixOutput,
  type RotationPeriod,
} from "@darkfactory/api";

import { isOperatorAccessDenied } from "./agent-ops-client.tsx";

// Read-only research lenses (researchLenses.*). No write procedure exists.
export interface ResearchLensesGateway {
  readonly rotationMatrix: (
    period: RotationPeriod
  ) => Promise<RotationMatrixOutput>;
  readonly deepValue: () => Promise<DeepValueOutput>;
  readonly score: (symbol: string) => Promise<DeepValueScoreOutput>;
}

export const createResearchLensesGateway = (
  client: ApiClient
): ResearchLensesGateway => ({
  rotationMatrix: (period) => client.researchLenses.rotationMatrix({ period }),
  deepValue: () => client.researchLenses.deepValue({}),
  score: (symbol) => client.researchLenses.deepValueScore({ symbol }),
});

export const createBrowserResearchLensesGateway = (): ResearchLensesGateway => {
  let gateway: ResearchLensesGateway | undefined;
  const current = (): ResearchLensesGateway => {
    gateway ??= createResearchLensesGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    rotationMatrix: (period: RotationPeriod) =>
      current().rotationMatrix(period),
    deepValue: () => current().deepValue(),
    score: (symbol: string) => current().score(symbol),
  });
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

/** One line for the page: the server's message, or the operator-access notice. */
/**
 * The next step after a failed research lens load. "press Try again" only when a retry can help:
 * missing operator access and data the nightly job has not written yet do not change on a retry,
 * and a STORAGE_ERROR message already names its next step (ask the operator).
 */
export const failureNextStep = (error: unknown): string | null => {
  if (isOperatorAccessDenied(error)) return "sign in with an operator account";
  const code = field(error, "code");
  if (code === "NOT_FOUND") return "try again after the nightly run";
  return code === "STORAGE_ERROR" ? null : "press Try again";
};

export const describeResearchLensFailure = (error: unknown): string => {
  if (isOperatorAccessDenied(error)) return "Operator access required.";
  const message = field(error, "message");
  return typeof message === "string" && message.trim() !== ""
    ? message.trim()
    : "Request failed.";
};
