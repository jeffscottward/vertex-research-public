"use client";

import { alertTitleClassName, alertVariants, Button } from "@darkfactory/ui";
import { useState } from "react";
import {
  type RouteError,
  routeErrorText,
} from "../../components/route-error-state.tsx";

export default function ResearchError({
  error,
  reset,
}: {
  readonly error?: RouteError;
  readonly reset: () => void;
}) {
  const [at] = useState(() => new Date());
  // The cause and the reference are named; the source response and the error message stay private.
  const text = routeErrorText(
    "This page",
    error,
    at,
    "The source response and private error details are not shown."
  );
  return (
    <section
      className={alertVariants({ variant: "destructive" })}
      role="alert"
      aria-labelledby="research-page-error-title"
    >
      <h1 className={alertTitleClassName} id="research-page-error-title">
        {text.title}
      </h1>
      <p>{text.description} Or return to the research overview.</p>
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
