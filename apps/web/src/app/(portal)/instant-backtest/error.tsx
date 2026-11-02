"use client";

import { Button, EmptyState } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";

export default function InstantBacktestError({
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
      description="The instant backtest page failed to render. No data was changed."
      icon={<RotateCcw />}
      title="Instant backtest unavailable"
    />
  );
}
