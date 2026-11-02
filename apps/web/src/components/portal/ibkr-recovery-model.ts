import type {
  IbkrRecoveryLoginState,
  IbkrRecoveryRequestState,
  IbkrRecoveryStatusOutput,
} from "@darkfactory/api";

import { clock, type HealthTone } from "./portfolio-monitor-model.ts";

// View model for the "Send IBKR 2FA request" control (Mission control account card).
// The button appears when the VPS reports a logged-out or stopped gateway (needsLogin), or a
// logged-in gateway whose account feeds are missing (feedsMissing).
// "starting", "awaiting-2fa", "unknown" and reader errors never show it.

// A finished request stays visible for this long so the operator can read the result.
export const RECENT_RESULT_MS = 30 * 60 * 1000;

const LOGIN_LABEL: Readonly<Record<IbkrRecoveryLoginState, string | null>> = {
  "awaiting-2fa": "IBKR login: waiting for 2FA approval",
  "logged-in": null,
  "logged-out": "IBKR login: logged out",
  starting: null,
  stopped: "IBKR login: gateway stopped",
  unknown: null,
};

const PROGRESS: Readonly<
  Record<IbkrRecoveryRequestState, { label: string; tone: HealthTone }>
> = {
  failed: { label: "Failed", tone: "destructive" },
  "logged-in": { label: "Logged in; account snapshot OK", tone: "success" },
  requested: { label: "2FA request sent to the VPS", tone: "neutral" },
  "timed-out": {
    label: "Timed out; no approval was received",
    tone: "destructive",
  },
  verifying: {
    label: "Login completed; checking the account snapshot",
    tone: "neutral",
  },
  "waiting-for-approval": {
    label: "Waiting for approval on your phone",
    tone: "warning",
  },
};

const recoveryNeeded = (status: IbkrRecoveryStatusOutput): boolean =>
  status.gateway.needsLogin ||
  (status.gateway.loginState === "logged-in" && status.gateway.feedsMissing);

const FEEDS_MISSING_LABEL = "IBKR account feeds missing";

export type RecoveryView = Readonly<{
  badge: Readonly<{ label: string; tone: HealthTone }> | null;
  // null: no button. Otherwise the button is shown; `hint` explains a disabled button.
  button: Readonly<{ enabled: boolean; hint: string | null }> | null;
  progress: Readonly<{
    state: IbkrRecoveryRequestState;
    label: string;
    tone: HealthTone;
    detail: string | null;
    meta: string;
    active: boolean;
    // The VPS re-check after the 900 s approval window: scheduled, or failed with its reason.
    recheck: string | null;
  }> | null;
}>;

const isActive = (status: IbkrRecoveryStatusOutput): boolean =>
  status.request !== null &&
  (status.request.scriptRunning ||
    !["logged-in", "timed-out", "failed"].includes(status.request.state));

const recheckText = (
  request: NonNullable<IbkrRecoveryStatusOutput["request"]>
): string | null => {
  if (request.recheck !== null && !request.recheck.ok)
    return `Re-check at ${clock(request.recheck.at)}: ${request.recheck.detail}`;
  if (request.recheckAt !== null && request.recheck === null)
    return `Auth re-check at ${clock(request.recheckAt)}`;
  return null;
};

const buttonHint = (status: IbkrRecoveryStatusOutput): string | null => {
  if (status.canRequest) return null;
  if (isActive(status)) return "A 2FA request is in progress.";
  if (status.cooldownUntil !== null)
    return `Next request possible at ${clock(status.cooldownUntil)}.`;
  return null;
};

export const recoveryView = (
  status: IbkrRecoveryStatusOutput,
  nowMs: number
): RecoveryView => {
  const label =
    status.gateway.loginState === "logged-in" && status.gateway.feedsMissing
      ? FEEDS_MISSING_LABEL
      : LOGIN_LABEL[status.gateway.loginState];
  const request = status.request;
  const finishedMs =
    request?.finishedAt === null || request?.finishedAt === undefined
      ? null
      : Date.parse(request.finishedAt);
  const recheckFailed = request?.recheck?.ok === false;
  const showProgress =
    request !== null &&
    (isActive(status) ||
      recheckFailed ||
      finishedMs === null ||
      nowMs - finishedMs <= RECENT_RESULT_MS);
  const progress =
    request === null || !showProgress
      ? null
      : {
          active: isActive(status),
          detail:
            request.detail.trim() === "" ||
            request.state === "logged-in" ||
            request.state === "requested"
              ? null
              : request.detail.trim(),
          label: PROGRESS[request.state].label,
          meta: `${request.requestedByYou ? "Requested by you" : "Requested by another operator"} at ${clock(request.requestedAt)}${request.finishedAt === null ? "" : ` · finished ${clock(request.finishedAt)}`}`,
          recheck: recheckText(request),
          state: request.state,
          tone: PROGRESS[request.state].tone,
        };
  return {
    badge:
      label === null
        ? null
        : {
            label,
            tone: recoveryNeeded(status) ? "destructive" : "warning",
          },
    button: recoveryNeeded(status)
      ? { enabled: status.canRequest, hint: buttonHint(status) }
      : null,
    progress,
  };
};

// Poll faster while a request moves, so each step shows within a few seconds.
export const pollIntervalMs = (
  status: IbkrRecoveryStatusOutput | null
): number => (status !== null && isActive(status) ? 3000 : 15_000);
