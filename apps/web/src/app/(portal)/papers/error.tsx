"use client";

import { Button, EmptyState } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";

export default function PapersError({ reset }: { readonly reset: () => void }) {
  return (
    <EmptyState
      action={
        <Button onClick={reset} variant="secondary">
          <RotateCcw aria-hidden="true" className="size-4" />
          Try again
        </Button>
      }
      description="The papers page failed to render. Unsaved edits were not submitted."
      icon={<RotateCcw />}
      title="Papers unavailable"
    />
  );
}
