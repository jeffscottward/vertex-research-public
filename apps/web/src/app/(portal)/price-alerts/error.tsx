"use client";

import {
  type RouteError,
  RouteErrorState,
} from "../../../components/route-error-state.tsx";

export default function PriceAlertsError({
  error,
  reset,
}: {
  readonly error?: RouteError;
  readonly reset: () => void;
}) {
  return (
    <RouteErrorState
      error={error}
      page="Price alerts"
      reset={reset}
      safety="No data was changed."
    />
  );
}
