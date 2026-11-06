"use client";

import {
  type ApiClient,
  createApiClient,
  type SignalAlertBackfillOutput,
  type SignalAlertCheckOutput,
  type SignalAlertCondition,
  type SignalAlertCreateInput,
  type SignalAlertEvent,
  type SignalAlertListOutput,
  type SignalAlertProposeOutput,
  type SignalAlertRule,
  type SignalAlertTimeframe,
} from "@darkfactory/api";

// Signal alerts and watch mode (priceAlerts.signals.*): list, create, backfill preview, Quant watch
// proposals, start/dismiss/remove, check now and the recent fires the page turns into browser
// notifications. The scheduler tick is not called from the page. Research only; no orders.
export interface SignalAlertsGateway {
  readonly backfill: (
    input: Readonly<{
      symbol: string;
      timeframe: SignalAlertTimeframe;
      condition: SignalAlertCondition;
    }>
  ) => Promise<SignalAlertBackfillOutput>;
  readonly check: () => Promise<SignalAlertCheckOutput>;
  readonly create: (input: SignalAlertCreateInput) => Promise<SignalAlertRule>;
  readonly dismiss: (id: string) => Promise<SignalAlertRule>;
  readonly events: (since: Date | null) => Promise<SignalAlertEvent[]>;
  readonly list: () => Promise<SignalAlertListOutput>;
  readonly propose: (text: string) => Promise<SignalAlertProposeOutput>;
  readonly remove: (id: string) => Promise<void>;
  readonly start: (id: string) => Promise<SignalAlertRule>;
}

export const createSignalAlertsGateway = (
  client: ApiClient
): SignalAlertsGateway => {
  const signals = client.priceAlerts.signals;
  return {
    backfill: (input) => signals.backfill(input),
    check: () => signals.check({}),
    create: async (input) => (await signals.create(input)).rule,
    dismiss: async (id) => (await signals.dismiss({ id })).rule,
    events: async (since) =>
      (await signals.events(since === null ? {} : { since })).events,
    list: () => signals.list({}),
    propose: (text) => signals.propose({ text }),
    remove: async (id) => {
      await signals.remove({ id });
    },
    start: async (id) => (await signals.start({ id })).rule,
  };
};

export const createBrowserSignalAlertsGateway = (): SignalAlertsGateway => {
  let gateway: SignalAlertsGateway | undefined;
  const current = (): SignalAlertsGateway => {
    gateway ??= createSignalAlertsGateway(
      createApiClient({ baseUrl: window.location.origin })
    );
    return gateway;
  };
  return Object.freeze({
    backfill: (input: Parameters<SignalAlertsGateway["backfill"]>[0]) =>
      current().backfill(input),
    check: () => current().check(),
    create: (input: SignalAlertCreateInput) => current().create(input),
    dismiss: (id: string) => current().dismiss(id),
    events: (since: Date | null) => current().events(since),
    list: () => current().list(),
    propose: (text: string) => current().propose(text),
    remove: (id: string) => current().remove(id),
    start: (id: string) => current().start(id),
  });
};

/** "Would have fired 105 times in the last 77 days" (LuxAlgo wording). */
export const describeBackfill = (
  backfill: SignalAlertBackfillOutput["backfill"]
): string =>
  backfill.bars === 0
    ? "No closed bars to backfill yet."
    : `Would have fired ${backfill.count} ${backfill.count === 1 ? "time" : "times"} in the last ${backfill.days} ${backfill.days === 1 ? "day" : "days"}.`;
