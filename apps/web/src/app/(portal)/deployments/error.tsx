"use client";

import { Button, EmptyState } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { useState } from "react";

// The title names the event and its time; the digest lets the server log name the cause.
const deploymentsErrorTitle = (at: Date): string => {
  return `Deployments failed to render at ${at.toISOString().slice(11, 16)} UTC`;
};

const deploymentsErrorDescription = (digest: string | undefined): string => {
  const reference = digest === undefined ? "" : ` Reference ${digest}.`;
  return `The deployments page failed to render. No service was changed.${reference}`;
};

export default function DeploymentsError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  const [at] = useState(() => new Date());
  return (
    <EmptyState
      action={
        <Button onClick={reset} variant="secondary">
          <RotateCcw aria-hidden="true" className="size-4" />
          Try again
        </Button>
      }
      description={deploymentsErrorDescription(error.digest)}
      icon={<RotateCcw />}
      title={deploymentsErrorTitle(at)}
    />
  );
}
