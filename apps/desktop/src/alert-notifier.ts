// What: native OS notifications for signal alert fires (LuxAlgo P4 feed, priceAlerts.signals.events)
// without an open Alerts page. Polls the feed, notifies once per batch of fires that happened after
// the app started (less a minute, for clock skew between this computer and the server), and opens
// the Alerts workspace on click. A fire committed more than ALERT_POLL_OVERLAP_MS behind the newest
// one already seen is not notified; the Alerts page still lists it. The text is fixed, as on the web page:
// names and prices stay inside the app, off the lock screen. Not an instruction to trade.
// Used by: app.ts.
import { SIGNAL_ALERT_NOTIFICATION } from "@darkfactory/api";

import type { AlertFire, DesktopApi } from "./desktop-api.ts";
import type { EveryPort, NotifyPort } from "./ports.ts";
import type { WorkspaceId } from "./workspaces.ts";

export const ALERT_POLL_MS = 60_000;
/** A concurrent run can commit an earlier-stamped fire late, so each poll looks back this far. */
export const ALERT_POLL_OVERLAP_MS = 5 * 60_000;
/** Fires this long before the app started still count as new (local clock vs server clock). */
export const ALERT_START_TOLERANCE_MS = 60_000;

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
  const newFrom = startedAt.getTime() - ALERT_START_TOLERANCE_MS;
  let cursor = startedAt;
  /** Fires already handled, by id, with their fire time so old ones can be dropped. */
  const known = new Map<string, number>();
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
      known.set(fire.id, fire.firedAt.getTime());
      if (fire.firedAt.getTime() >= newFrom) fresh += 1;
    }
    // Later polls ask only for fires after cursor - overlap, so older ids can never come back.
    const oldest = cursor.getTime() - ALERT_POLL_OVERLAP_MS;
    for (const [id, firedAt] of known) if (firedAt < oldest) known.delete(id);
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
