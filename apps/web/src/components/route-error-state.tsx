"use client";

import { Button, buttonVariants, EmptyState } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { startTransition, useState } from "react";

export type RouteErrorCause =
  | "session-expired"
  | "network-failed"
  | "server-error"
  | "render-error";

export type RouteError = Error & { readonly digest?: string };

const SESSION_PATTERN = /\b(401|403)\b|UNAUTHORIZED|FORBIDDEN/;
const NETWORK_PATTERN =
  /Failed to fetch|NetworkError|ERR_NETWORK|\btimeout\b|\btimed out\b/i;

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

export const routeErrorText = (
  page: string,
  error: RouteError | undefined,
  at: Date,
  safety: string
): { readonly title: string; readonly description: string } => {
  const digest = error?.digest ? ` Reference: ${error.digest}.` : "";
  return {
    description: `${CAUSE_TEXT[routeErrorCause(error)]}${digest} ${safety} Select Try again to render this page again.`,
    title: `${page} failed to render at ${at.toISOString().slice(11, 16)} UTC`,
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
  const router = useRouter();
  const pathname = usePathname();
  const [at] = useState(() => new Date());
  const cause = routeErrorCause(error);
  const text = routeErrorText(page, error, at, safety);
  // A server render error needs fresh server data; reset() alone re-renders the cached payload.
  const retry = () =>
    cause === "server-error"
      ? startTransition(() => {
          router.refresh();
          reset();
        })
      : reset();
  return (
    <EmptyState
      action={
        <div className="flex flex-wrap gap-2">
          {cause === "session-expired" ? (
            <a
              className={buttonVariants()}
              href={`/sign-in?callbackURL=${encodeURIComponent(pathname)}`}
            >
              Sign in
            </a>
          ) : null}
          <Button onClick={retry} variant="secondary">
            <RotateCcw aria-hidden="true" className="size-4" />
            Try again
          </Button>
        </div>
      }
      description={text.description}
      icon={<RotateCcw />}
      title={text.title}
    />
  );
}
