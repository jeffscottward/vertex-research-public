"use client";

import {
  type RouteError,
  RouteErrorState,
} from "../../../components/route-error-state.tsx";

export default function JournalError({
  error,
  reset,
}: {
  readonly error?: RouteError;
  readonly reset: () => void;
}) {
  return (
    <RouteErrorState
      error={error}
      page="Trade journal"
      reset={reset}
      safety="It is read-only, so nothing was sent to IBKR."
    />
  );
}
