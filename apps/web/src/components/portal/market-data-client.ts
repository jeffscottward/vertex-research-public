"use client";

import {
  createApiClient,
  type ApiClient,
  type MarketBarsInput,
  type MarketBarsOutput,
} from "@darkfactory/api";

// Read-only IBKR historical bars (marketData.bars).
export interface MarketDataGateway {
  readonly bars: (input: MarketBarsInput) => Promise<MarketBarsOutput>;
}

const createMarketDataGateway = (client: ApiClient): MarketDataGateway => ({
  bars: (input) => client.marketData.bars(input),
});

export const createBrowserMarketDataGateway = (): MarketDataGateway => {
  let gateway: MarketDataGateway | undefined;
  const current = (): MarketDataGateway => {
    gateway ??= createMarketDataGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    bars: (input: MarketBarsInput) => current().bars(input),
  });
};

export type MarketDataFailure = Readonly<{ code: string; message: string }>;

const field = (value: unknown, key: string): unknown => {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;
};

const text = (value: unknown): string | null => {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
};

// Validation issues from oRPC BAD_REQUEST arrive in data.issues; show their messages.
const issueMessages = (error: unknown): string | null => {
  const issues = field(field(error, "data"), "issues");
  if (!Array.isArray(issues)) return null;
  const messages = issues
    .map((issue) => text(field(issue, "message")))
    .filter((message): message is string => message !== null);
  return messages.length > 0 ? messages.slice(0, 4).join("; ") : null;
};

// Keeps the server's oRPC code and message (PACED, ENTITLEMENT, NOT_CONFIGURED, ...).
export const describeMarketDataFailure = (
  error: unknown
): MarketDataFailure => {
  const code = text(field(error, "code")) ?? "ERROR";
  const message =
    issueMessages(error) ?? text(field(error, "message")) ?? "Request failed";
  return { code, message };
};
