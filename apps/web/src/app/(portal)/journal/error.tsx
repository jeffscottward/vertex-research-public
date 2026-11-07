"use client";

import { Button, EmptyState } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";

export default function JournalError({
  reset,
}: {
  readonly reset: () => void;
}) {
  return (
    <EmptyState
      action={
        <Button onClick={reset} variant="secondary">
          <RotateCcw aria-hidden="true" className="size-4" />
          Try again
        </Button>
      }
      description="The trade journal failed to render. It is read-only, so nothing was sent to IBKR."
      icon={<RotateCcw />}
      title="Trade journal unavailable"
    />
  );
}
