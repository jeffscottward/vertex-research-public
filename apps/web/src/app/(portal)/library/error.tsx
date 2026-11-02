"use client";

import { Button, EmptyState } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";

export default function StrategyLibraryError({
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
      description="The strategy library failed to render. No data was changed."
      icon={<RotateCcw />}
      title="Strategy library unavailable"
    />
  );
}
