"use client";

import { Button, EmptyState } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { useState } from "react";

export type RouteErrorCause =
  | "session-expired"
  | "network-failed"
  | "server-error"
  | "render-error";

export type RouteError = Error & { readonly digest?: string };

const SESSION_PATTERN = /\b(401|403|unauthori[sz]ed|forbidden|session)\b/i;
const NETWORK_PATTERN = /\b(failed to fetch|network|timed? ?out|econn)/i;

export const routeErrorCause = (
  error: RouteError | undefined
): RouteErrorCause => {
  const message = error?.message ?? "";
  if (SESSION_PATTERN.test(message)) return "session-expired";
  if (NETWORK_PATTERN.test(message)) return "network-failed";
  if (error?.digest) return "server-error";
  return "render-error";
};

const CAUSE_TEXT: Readonly<Record<RouteErrorCause, string>> = {
  "network-failed": "Cause: a network request failed.",
  "render-error": "Cause: the page code hit an error while rendering.",
  "server-error": "Cause: the server hit an error while rendering.",
  "session-expired":
    "Cause: your session expired or lacks access. Sign in again.",
};

const utcClock = (at: Date): string => `${at.toISOString().slice(11, 16)} UTC`;

export const routeErrorText = (
  page: string,
  error: RouteError | undefined,
  at: Date,
  safety: string
): { readonly title: string; readonly description: string } => {
  const digest = error?.digest ? ` Reference: ${error.digest}.` : "";
  return {
    description: `${CAUSE_TEXT[routeErrorCause(error)]}${digest} ${safety} Select Try again to reload it.`,
    title: `${page} failed to render at ${utcClock(at)}`,
  };
};

export function RouteErrorState({
  error,
  page,
  reset,
  safety,
}: {
  readonly error?: RouteError | undefined;
  readonly page: string;
  readonly reset: () => void;
  readonly safety: string;
}) {
  const [at] = useState(() => new Date());
  const text = routeErrorText(page, error, at, safety);
  return (
    <EmptyState
      action={
        <Button onClick={reset} variant="secondary">
          <RotateCcw aria-hidden="true" className="size-4" />
          Try again
        </Button>
      }
      description={text.description}
      icon={<RotateCcw />}
      title={text.title}
    />
  );
}
