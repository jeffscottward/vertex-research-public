"use client";

import {
  type ApiClient,
  createApiClient,
  type PriceAlertCheckOutput,
  type PriceAlertCreateInput,
  type PriceAlertListOutput,
  type PriceAlertRule,
} from "@darkfactory/api";

import { isOperatorAccessDenied } from "./agent-ops-client.tsx";

// Price alerts (priceAlerts.*): list, create, remove and check the owner's rules. The scheduler tick
// is not called from the page. Research only; no orders.
export interface PriceAlertsGateway {
  readonly check: () => Promise<PriceAlertCheckOutput>;
  readonly create: (input: PriceAlertCreateInput) => Promise<PriceAlertRule>;
  readonly list: () => Promise<PriceAlertListOutput>;
  readonly remove: (id: string) => Promise<void>;
}

export const createPriceAlertsGateway = (
  client: ApiClient
): PriceAlertsGateway => ({
  check: () => client.priceAlerts.check({}),
  create: async (input) => (await client.priceAlerts.create(input)).rule,
  list: () => client.priceAlerts.list({}),
  remove: async (id) => {
    await client.priceAlerts.remove({ id });
  },
});

export const createBrowserPriceAlertsGateway = (): PriceAlertsGateway => {
  let gateway: PriceAlertsGateway | undefined;
  const current = (): PriceAlertsGateway => {
    gateway ??= createPriceAlertsGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    check: () => current().check(),
    create: (input: PriceAlertCreateInput) => current().create(input),
    list: () => current().list(),
    remove: (id: string) => current().remove(id),
  });
};

/** One line for the page: the server's message, or the operator-access notice. */
export const describePriceAlertFailure = (error: unknown): string => {
  if (isOperatorAccessDenied(error)) return "Operator access required.";
  const message =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "message")
      : undefined;
  return typeof message === "string" && message.trim() !== ""
    ? message.trim()
    : "Request failed.";
};
