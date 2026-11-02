"use client";

import {
  NAUTILUS_ARM_REASON_MAX,
  NAUTILUS_ARM_STATEMENT,
  type NautilusArmStatusOutput,
} from "@darkfactory/api";
import { Button, StatusBadge } from "@darkfactory/ui";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  createBrowserNautilusArmGateway,
  type NautilusArmGateway,
} from "./nautilus-arm-client.ts";
import {
  NAUTILUS_POLL_MS,
  nautilusArmView,
  reasonProblem,
  UNREACHABLE_BADGE,
} from "./nautilus-arm-model.ts";
import {
  describePortfolioMonitorFailure,
  type PortfolioMonitorFailure,
} from "./portfolio-monitor-client.ts";

// Nautilus node arm switch (Mission control, operator view). Owner decision 2026-10-30: the node runs
// 24/7 and is disarmed by default. Arm opens a dialog: typed reason, the owner's password and the exact
// statement. Disarm is one click. Nothing here is sent automatically or retried.

export interface NautilusArmProps {
  // false: the server has no bridge address; nothing is sent and nothing is shown.
  readonly configured?: boolean;
  readonly gateway?: NautilusArmGateway;
}

// Failures that polling cannot fix: the control hides itself and stops polling.
const SILENT_FAILURES: Readonly<Partial<Record<string, true>>> = {
  forbidden: true,
  "not-configured": true,
  unauthorized: true,
};

export type NautilusArmModel = Readonly<{
  status: NautilusArmStatusOutput | null;
  failure: PortfolioMonitorFailure | null;
  hidden: boolean;
  dialogOpen: boolean;
  reason: string;
  password: string;
  sending: "arm" | "disarm" | null;
  error: string | null;
  setReason: (value: string) => void;
  setPassword: (value: string) => void;
  open: (origin: HTMLElement) => void;
  cancel: () => void;
  // imageVersion: the version shown in the dialog; the node refuses another running version.
  arm: (imageVersion: string) => Promise<void>;
  disarm: () => Promise<void>;
}>;

const failureText = (error: unknown, action: "arm" | "disarm"): string => {
  const described = describePortfolioMonitorFailure(error);
  // A refused password is FORBIDDEN too; show the server's own message, not "Operator access required".
  const raw = (error as { message?: unknown } | null | undefined)?.message;
  const reason = `${described.code}: ${typeof raw === "string" && raw !== "" ? raw : described.message}`;
  return described.kind === "unavailable"
    ? `No answer from the VPS (${reason}). The node may have changed; check the badge.`
    : `The node was not ${action === "arm" ? "armed" : "disarmed"} (${reason}).`;
};

export const useNautilusArm = ({
  configured = false,
  gateway: suppliedGateway,
}: NautilusArmProps): NautilusArmModel => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserNautilusArmGateway()
  );
  const [status, setStatus] = useState<NautilusArmStatusOutput | null>(null);
  const [failure, setFailure] = useState<PortfolioMonitorFailure | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [sending, setSending] = useState<"arm" | "disarm" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // The Arm button gets focus back when the dialog closes.
  const origin = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!configured) return;
    let alive = true;
    let timer: number | undefined;
    const load = async (): Promise<void> => {
      try {
        const next = await gateway.status();
        if (!alive) return;
        setStatus(next);
        setFailure(null);
      } catch (caught) {
        if (!alive) return;
        const described = describePortfolioMonitorFailure(caught);
        setFailure(described);
        if (SILENT_FAILURES[described.kind]) return;
      }
      timer = window.setTimeout(() => void load(), NAUTILUS_POLL_MS);
    };
    void load();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [configured, gateway, reloadKey]);

  const close = () => {
    setDialogOpen(false);
    setPassword("");
    setReason("");
    origin.current?.focus();
  };

  return {
    arm: async (imageVersion) => {
      setSending("arm");
      setError(null);
      try {
        await gateway.arm({ imageVersion, password, reason });
        close();
      } catch (caught) {
        setPassword("");
        setError(failureText(caught, "arm"));
      }
      setSending(null);
      setReloadKey((key) => key + 1);
    },
    cancel: () => {
      setError(null);
      close();
    },
    dialogOpen,
    disarm: async () => {
      setSending("disarm");
      setError(null);
      try {
        await gateway.disarm();
      } catch (caught) {
        setError(failureText(caught, "disarm"));
      }
      setSending(null);
      setReloadKey((key) => key + 1);
    },
    error,
    failure,
    hidden:
      !configured ||
      (failure !== null && SILENT_FAILURES[failure.kind] === true),
    open: (opener) => {
      origin.current = opener;
      setError(null);
      setDialogOpen(true);
    },
    password,
    reason,
    sending,
    setPassword,
    setReason,
    status,
  };
};

// Header part: the node badge, then Arm (opens the dialog) or Disarm (one click).
export const NautilusArmControls = ({
  model,
}: {
  readonly model: NautilusArmModel;
}) => {
  if (model.hidden) return null;
  if (model.status === null || model.failure !== null) {
    if (model.failure === null) return null;
    return (
      <>
        <span className="text-muted-foreground text-xs">Nautilus</span>
        <StatusBadge
          data-nautilus-badge="unreachable"
          status={UNREACHABLE_BADGE.tone}
          title={`${model.failure.code}: ${model.failure.message}`}
        >
          {UNREACHABLE_BADGE.label}
        </StatusBadge>
      </>
    );
  }
  const view = nautilusArmView(model.status);
  return (
    <>
      <span className="text-muted-foreground text-xs">Nautilus</span>
      <StatusBadge
        data-nautilus-badge={view.badge.key}
        status={view.badge.tone}
      >
        {view.badge.label}
      </StatusBadge>
      {view.arm === null ? null : (
        <Button
          aria-controls="nautilus-arm-dialog"
          aria-describedby={
            view.arm.hint === null ? undefined : "nautilus-arm-hint"
          }
          aria-expanded={model.dialogOpen}
          data-nautilus-arm-button="true"
          disabled={!view.arm.enabled || model.sending !== null}
          onClick={(event) => model.open(event.currentTarget)}
          size="compact"
          variant="secondary"
        >
          <ShieldCheck aria-hidden="true" className="size-4" />
          Arm
        </Button>
      )}
      {view.disarm ? (
        <Button
          data-nautilus-disarm-button="true"
          loading={model.sending === "disarm"}
          loadingLabel="Disarming the node"
          onClick={() => void model.disarm()}
          size="compact"
          variant="destructive"
        >
          <ShieldOff aria-hidden="true" className="size-4" />
          Disarm
        </Button>
      ) : null}
    </>
  );
};

// Below the header: hints, the arm dialog, and errors from the last arm or disarm.
export const NautilusArmPanel = ({
  model,
}: {
  readonly model: NautilusArmModel;
}) => {
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (model.dialogOpen) reasonRef.current?.focus();
  }, [model.dialogOpen]);
  if (model.hidden || model.status === null) return null;
  const view = nautilusArmView(model.status);
  const problem = reasonProblem(model.reason);
  const imageVersion = model.status.arm?.imageVersion ?? "unknown";
  const canSend =
    problem === null && model.password !== "" && model.sending === null;
  return (
    <div className="space-y-2" data-nautilus-arm="true">
      {view.arm?.hint === null || view.arm === null ? null : (
        <p className="text-muted-foreground text-xs" id="nautilus-arm-hint">
          {view.arm.hint}
        </p>
      )}
      {view.detail === null ? null : (
        <p
          className="text-sm text-warning-foreground"
          data-nautilus-detail="true"
        >
          {view.detail}
        </p>
      )}
      {model.error === null || model.dialogOpen ? null : (
        <p className="text-destructive text-sm" role="alert">
          {model.error}
        </p>
      )}
      {model.dialogOpen && view.arm !== null ? (
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Escape handling for key events that bubble from the dialog fields.
        <form
          aria-describedby="nautilus-arm-body"
          aria-labelledby="nautilus-arm-title"
          className="space-y-3 rounded-md border border-warning-border bg-warning-subtle p-4"
          data-nautilus-arm-dialog="true"
          id="nautilus-arm-dialog"
          onKeyDown={(event) => {
            if (event.key === "Escape" && model.sending === null)
              model.cancel();
          }}
          onSubmit={(event) => {
            event.preventDefault();
            if (canSend) void model.arm(imageVersion);
          }}
          role="dialog"
        >
          <p
            className="font-medium text-sm text-warning-foreground"
            id="nautilus-arm-title"
          >
            Arm the Nautilus node?
          </p>
          <div
            className="space-y-2 text-foreground text-sm"
            id="nautilus-arm-body"
          >
            <p>
              When armed, the node may submit live orders to IBKR. It stays
              armed until you disarm it, the kill switch is set, or the image
              version changes. Image version: {imageVersion}.
            </p>
            <blockquote
              className="border-warning-border border-l-4 pl-3 font-medium"
              data-nautilus-statement="true"
            >
              {NAUTILUS_ARM_STATEMENT}
            </blockquote>
          </div>
          <label
            className="block space-y-1 text-sm"
            htmlFor="nautilus-arm-reason"
          >
            <span className="font-medium">Reason</span>
            <textarea
              aria-describedby="nautilus-arm-reason-help"
              className="block min-h-16 w-full rounded-md border border-border-strong bg-surface px-2 py-1 text-foreground text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              id="nautilus-arm-reason"
              maxLength={NAUTILUS_ARM_REASON_MAX}
              onChange={(event) => model.setReason(event.target.value)}
              ref={reasonRef}
              value={model.reason}
            />
            <span
              className="text-muted-foreground text-xs tabular-nums"
              id="nautilus-arm-reason-help"
            >
              {`${model.reason.length} / ${NAUTILUS_ARM_REASON_MAX}${problem === null ? "" : ` · ${problem}`}`}
            </span>
          </label>
          <label
            className="block space-y-1 text-sm"
            htmlFor="nautilus-arm-password"
          >
            <span className="font-medium">Your password</span>
            <input
              autoComplete="current-password"
              className="block min-h-11 w-full rounded-md border border-border-strong bg-surface px-2 text-foreground text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              id="nautilus-arm-password"
              onChange={(event) => model.setPassword(event.target.value)}
              type="password"
              value={model.password}
            />
          </label>
          {model.error === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {model.error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!canSend}
              loading={model.sending === "arm"}
              loadingLabel="Arming the node"
              type="submit"
              variant="destructive"
            >
              Arm the node
            </Button>
            <Button
              disabled={model.sending !== null}
              onClick={model.cancel}
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
};
