"use client";

import {
  type RouteError,
  RouteErrorState,
} from "../../../components/route-error-state.tsx";

export default function MarketsError({
  error,
  reset,
}: {
  readonly error?: RouteError;
  readonly reset: () => void;
}) {
  return (
    <RouteErrorState
      error={error}
      page="Market context"
      reset={reset}
      safety="No data was changed."
    />
  );
}
