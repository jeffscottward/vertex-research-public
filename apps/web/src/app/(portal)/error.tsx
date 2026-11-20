"use client";

import {
  type RouteError,
  RouteErrorState,
} from "../../components/route-error-state.tsx";

// The boundary of the portal segment: any page without its own error file.
// The cause and the reference are named; the source response and the error message stay private.
export default function ResearchError({
  error,
  reset,
}: {
  readonly error?: RouteError;
  readonly reset: () => void;
}) {
  return (
    <section
      aria-labelledby="portal-error-title"
      data-portal-error=""
      role="alert"
    >
      <h1 className="sr-only" id="portal-error-title">
        Page error
      </h1>
      <RouteErrorState
        error={error}
        page="This page"
        reset={reset}
        safety="The source response and private error details are not shown."
      />
      <p className="vx-actions">
        <a className="vx-text-link" href="/dashboard">
          Return to overview
        </a>
      </p>
    </section>
  );
}
