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

// Codes where the same request gives the same answer: rejected input, no access, lens endpoint not
// configured. NOT_FOUND is not one of them: the score path sends it when both the price read and
// the SEC read failed, which includes timeouts and 5xx answers, so a retry can succeed.
const PERMANENT_CODES: Readonly<Record<string, true>> = {
  BAD_REQUEST: true,
  FORBIDDEN: true,
  NOT_CONFIGURED: true,
  UNAUTHORIZED: true,
};

/** False when asking again cannot change the answer, so the page offers no Retry. */
export const isRetryableResearchLensFailure = (error: unknown): boolean => {
  const code = field(error, "code");
  return !(typeof code === "string" && PERMANENT_CODES[code] === true);
};

/** One line for the page: the server's message, or the operator-access notice. */
export const describeResearchLensFailure = (error: unknown): string => {
  if (isOperatorAccessDenied(error)) return "Operator access required.";
  const message = field(error, "message");
  return typeof message === "string" && message.trim() !== ""
    ? message.trim()
    : "Request failed.";
};
