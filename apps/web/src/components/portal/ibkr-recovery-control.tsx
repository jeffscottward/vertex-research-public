"use client";

import type { IbkrRecoveryStatusOutput } from "@darkfactory/api";
import { RECOVERY_CONFIRMATION } from "@darkfactory/shared/vertex";
import { Button, StatusBadge } from "@darkfactory/ui";
import { Smartphone } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

import {
  createBrowserIbkrRecoveryGateway,
  type IbkrRecoveryGateway,
} from "./ibkr-recovery-client.ts";
import { pollIntervalMs, recoveryView } from "./ibkr-recovery-model.ts";
import {
  describePortfolioMonitorFailure,
  type PortfolioMonitorFailure,
} from "./portfolio-monitor-client.ts";
import type { HealthTone } from "./portfolio-monitor-model.ts";

// "Send IBKR 2FA request" (Mission control account card). The operator presses the button, confirms the
// recovery statement, and the server asks the VPS to start the existing 2FA script once. The button
// shows only for a logged-out or stopped gateway. Nothing here is sent automatically or retried.

export interface IbkrRecoveryProps {
  // false: the server has no recovery service address; no request is sent and nothing is shown.
  readonly configured?: boolean;
  readonly gateway?: IbkrRecoveryGateway;
}

// Failures that polling cannot fix: the control hides itself and stops polling.
const SILENT_FAILURES: Readonly<Partial<Record<string, true>>> = {
  forbidden: true,
  "not-configured": true,
  unauthorized: true,
};

export type IbkrRecoveryModel = Readonly<{
  status: IbkrRecoveryStatusOutput | null;
  failure: PortfolioMonitorFailure | null;
  hidden: boolean;
  confirming: boolean;
  sending: boolean;
  sendError: string | null;
  // The live progress region; it takes focus after a successful send.
  progressRef: RefObject<HTMLDivElement | null>;
  open: (origin: HTMLElement) => void;
  cancel: () => void;
  confirm: () => Promise<void>;
}>;

export const useIbkrRecovery = ({
  configured = false,
  gateway: suppliedGateway,
}: IbkrRecoveryProps): IbkrRecoveryModel => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserIbkrRecoveryGateway()
  );
  const [status, setStatus] = useState<IbkrRecoveryStatusOutput | null>(null);
  const [failure, setFailure] = useState<PortfolioMonitorFailure | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // The button that opened the dialog gets focus back when the dialog closes.
  const origin = useRef<HTMLElement | null>(null);
  const progress = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!configured) return;
    let alive = true;
    let timer: number | undefined;
    const load = async (): Promise<void> => {
      let next: IbkrRecoveryStatusOutput | null = null;
      try {
        next = await gateway.status();
        if (!alive) return;
        setStatus(next);
        setFailure(null);
      } catch (error) {
        if (!alive) return;
        const described = describePortfolioMonitorFailure(error);
        setFailure(described);
        if (SILENT_FAILURES[described.kind]) return;
      }
      timer = window.setTimeout(() => void load(), pollIntervalMs(next));
    };
    void load();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [configured, gateway, reloadKey]);

  const confirm = async (): Promise<void> => {
    setSending(true);
    setSendError(null);
    try {
      await gateway.request();
      setConfirming(false);
      // The trigger button is disabled now; the progress region takes focus.
      progress.current?.focus();
    } catch (error) {
      const described = describePortfolioMonitorFailure(error);
      const reason = `${described.code}: ${described.message}`;
      // No answer from the VPS: the request may have started. The progress shows the real state.
      setSendError(
        described.kind === "unavailable"
          ? `No answer from the VPS (${reason}). The request may have been sent; check the progress below.`
          : `The request was not sent (${reason}).`
      );
    }
    setSending(false);
    setReloadKey((key) => key + 1);
  };

  return {
    cancel: () => {
      setConfirming(false);
      setSendError(null);
      origin.current?.focus();
    },
    confirm,
    confirming,
    failure,
    hidden:
      !configured ||
      (failure !== null && SILENT_FAILURES[failure.kind] === true),
    open: (opener) => {
      origin.current = opener;
      setSendError(null);
      setConfirming(true);
    },
    progressRef: progress,
    sendError,
    sending,
    status,
  };
};

// Header part, next to the gateway status badge: login badge and the button.
export const IbkrRecoveryButton = ({
  model,
  nowMs,
}: {
  readonly model: IbkrRecoveryModel;
  readonly nowMs: number;
}) => {
  if (model.hidden || model.status === null) return null;
  const view = recoveryView(model.status, nowMs);
  return (
    <>
      {view.badge === null ? null : (
        <StatusBadge
          data-ibkr-login={model.status.gateway.loginState}
          status={view.badge.tone}
        >
          {view.badge.label}
        </StatusBadge>
      )}
      {view.button === null ? null : (
        <Button
          aria-describedby={
            view.button.hint === null ? undefined : "ibkr-recovery-hint"
          }
          aria-controls="ibkr-recovery-confirm"
          aria-expanded={model.confirming}
          data-ibkr-recovery-button="true"
          disabled={!view.button.enabled}
          onClick={(event) => model.open(event.currentTarget)}
          size="compact"
          variant="default"
        >
          <Smartphone aria-hidden="true" className="size-4" />
          Send IBKR 2FA request
        </Button>
      )}
    </>
  );
};

const PROGRESS_CLASS: Readonly<Record<HealthTone, string>> = {
  destructive:
    "border-destructive-border bg-destructive-subtle text-destructive",
  neutral: "border-border bg-surface text-foreground",
  success: "border-success-border bg-success-subtle text-success-foreground",
  warning: "border-warning-border bg-warning-subtle text-warning-foreground",
};

// Below the header: cooldown hint, confirm dialog, progress and send errors.
export const IbkrRecoveryPanel = ({
  model,
  nowMs,
}: {
  readonly model: IbkrRecoveryModel;
  readonly nowMs: number;
}) => {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (model.confirming) confirmRef.current?.focus();
  }, [model.confirming]);
  if (model.hidden) return null;
  if (model.status === null) {
    if (model.failure === null) return null;
    return (
      <p
        className="text-muted-foreground text-xs"
        data-ibkr-recovery-failure={model.failure.code}
      >
        {`IBKR login state unavailable (${model.failure.code}: ${model.failure.message}).`}
      </p>
    );
  }
  const view = recoveryView(model.status, nowMs);
  return (
    <div className="space-y-2" data-ibkr-recovery="true">
      {view.button?.hint === null || view.button === null ? null : (
        <p className="text-muted-foreground text-xs" id="ibkr-recovery-hint">
          {view.button.hint}
        </p>
      )}
      {model.confirming ? (
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Escape handling for key events that bubble from the confirmation buttons.
        <div
          aria-describedby="ibkr-recovery-confirm-body"
          aria-labelledby="ibkr-recovery-confirm-title"
          className="space-y-3 rounded-md border border-warning-border bg-warning-subtle p-4"
          data-ibkr-recovery-confirm="true"
          id="ibkr-recovery-confirm"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !model.sending) model.cancel();
          }}
          role="alertdialog"
        >
          <p
            className="font-medium text-sm text-warning-foreground"
            id="ibkr-recovery-confirm-title"
          >
            Send an IBKR 2FA login request?
          </p>
          <div
            className="space-y-2 text-foreground text-sm"
            id="ibkr-recovery-confirm-body"
          >
            <p>
              The VPS restarts the IBKR gateway once. IBKR then sends a login
              prompt to your phone. Approve it within 3 minutes.
            </p>
            {model.status.gateway.feedsMissing &&
            model.status.gateway.loginState === "logged-in" ? (
              <p data-ibkr-recovery-feeds-warning="true">
                The gateway is logged in, but the account feeds are missing.
                This restarts the gateway and ends the current session.
              </p>
            ) : null}
            <blockquote
              className="border-warning-border border-l-4 pl-3 font-medium"
              data-recovery-statement="true"
            >
              {RECOVERY_CONFIRMATION}
            </blockquote>
          </div>
          {model.sendError === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {model.sendError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              loading={model.sending}
              loadingLabel="Sending the 2FA request"
              onClick={() => void model.confirm()}
              ref={confirmRef}
            >
              Confirm and send
            </Button>
            <Button
              disabled={model.sending}
              onClick={model.cancel}
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <div
        aria-live="polite"
        className="outline-none"
        ref={model.progressRef}
        role="status"
        tabIndex={-1}
      >
        {view.progress === null ? null : (
          <div
            className={`rounded-md border px-3 py-2 text-sm ${PROGRESS_CLASS[view.progress.tone]}`}
            data-ibkr-recovery-state={view.progress.state}
          >
            <p className="font-medium">{view.progress.label}</p>
            {view.progress.detail === null ? null : (
              <p className="text-sm">{view.progress.detail}</p>
            )}
            <p className="text-xs tabular-nums opacity-80">
              {view.progress.meta}
            </p>
            {view.progress.recheck === null ? null : (
              <p
                className="text-xs tabular-nums opacity-80"
                data-ibkr-recovery-recheck="true"
              >
                {view.progress.recheck}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
