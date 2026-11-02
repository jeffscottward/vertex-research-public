"use client";

import { alertTitleClassName, alertVariants, Button } from "@darkfactory/ui";

export default function ResearchError({
  reset,
}: {
  readonly reset: () => void;
}) {
  return (
    <section
      className={alertVariants({ variant: "destructive" })}
      role="alert"
      aria-labelledby="research-page-error-title"
    >
      <h1 className={alertTitleClassName} id="research-page-error-title">
        Workspace page unavailable
      </h1>
      <p>
        This page does not show the source response or private error details.
        Try again or return to the research overview.
      </p>
      <div className="vx-actions">
        <Button variant="outline" type="button" onClick={reset}>
          Retry page
        </Button>
        <a className="vx-text-link" href="/dashboard">
          Return to overview
        </a>
      </div>
    </section>
  );
}
