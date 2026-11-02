"use client";

import { Button, EmptyState } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";

export default function TodosError({ reset }: { readonly reset: () => void }) {
  return (
    <EmptyState
      action={
        <Button onClick={reset} variant="secondary">
          <RotateCcw aria-hidden="true" className="size-4" />
          Try again
        </Button>
      }
      description="The to-do page failed to render. Unsaved edits were not submitted."
      icon={<RotateCcw />}
      title="Todos unavailable"
    />
  );
}
