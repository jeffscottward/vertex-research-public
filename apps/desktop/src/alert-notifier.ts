// What: native OS notifications for signal alert fires (LuxAlgo P4 feed, priceAlerts.signals.events)
// without an open Alerts page. Polls the feed, notifies once per batch of fires that happened after
// the app started, and opens the Alerts workspace on click. The text is fixed, as on the web page:
// names and prices stay inside the app, off the lock screen. Not an instruction to trade.
// Used by: app.ts.
import { SIGNAL_ALERT_NOTIFICATION } from "@darkfactory/api";

import type { AlertFire, DesktopApi } from "./desktop-api.ts";
import type { EveryPort, NotifyPort } from "./ports.ts";
import type { WorkspaceId } from "./workspaces.ts";

export const ALERT_POLL_MS = 60_000;
/** A concurrent run can commit an earlier-stamped fire late, so each poll looks back this far. */
export const ALERT_POLL_OVERLAP_MS = 5 * 60_000;

export const TEST_NOTIFICATION = Object.freeze({
  body: "Vertex desktop notifications are working. This is a test.",
  title: "Vertex test notification",
});

export interface AlertNotifier {
  readonly poll: () => Promise<void>;
  readonly sendTest: () => void;
  readonly start: () => void;
  readonly stop: () => void;
}

export const createAlertNotifier = (
  options: Readonly<{
    api: DesktopApi;
    notify: NotifyPort;
    every: EveryPort;
    now: () => Date;
    openWorkspace: (id: WorkspaceId) => void;
    pollMs?: number;
  }>
): AlertNotifier => {
  const startedAt = options.now();
  let cursor = startedAt;
  const known = new Set<string>();
  let inflight: Promise<void> | null = null;
  let stopTimer: (() => void) | null = null;

  const check = async () => {
    let fires: readonly AlertFire[];
    try {
      fires = await options.api.alertFires(
        new Date(cursor.getTime() - ALERT_POLL_OVERLAP_MS)
      );
    } catch {
      // Signed out or offline: the next poll retries from the same cursor.
      return;
    }
    let fresh = 0;
    for (const fire of fires) {
      if (fire.firedAt > cursor) cursor = fire.firedAt;
      if (known.has(fire.id)) continue;
      known.add(fire.id);
      if (fire.firedAt >= startedAt) fresh += 1;
    }
    if (fresh === 0) return;
    options.notify({
      body: SIGNAL_ALERT_NOTIFICATION.body,
      onClick: () => options.openWorkspace("price-alerts"),
      title: SIGNAL_ALERT_NOTIFICATION.title,
    });
  };

  const poll = (): Promise<void> => {
    inflight ??= check().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return {
    poll,
    sendTest: () =>
      options.notify({
        ...TEST_NOTIFICATION,
        onClick: () => options.openWorkspace("price-alerts"),
      }),
    start: () => {
      void poll();
      stopTimer ??= options.every(options.pollMs ?? ALERT_POLL_MS, () => {
        void poll();
      });
    },
    stop: () => {
      stopTimer?.();
      stopTimer = null;
    },
  };
};
